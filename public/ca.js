/*
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
Usage:
  const gui = new dat.GUI();
  const ca = new CA(gl, models_json, [W, H], gui); // gui is optional
  ca.step();
  
  ca.paint(x, y, radius, modelIndex);
  ca.clearCircle(x, y, radius;

  const stats = ca.benchmark();
  ca.draw();
  ca.draw(zoom);
*/

const vs_code = `
    attribute vec4 position;
    varying vec2 uv;
    void main() {
        uv = position.xy*0.5 + 0.5;
        gl_Position = position;
    }
`

function defInput(name) {
    return `
        uniform Tensor ${name};
        uniform sampler2D ${name}_tex;

        vec4 ${name}_read(vec2 pos, float ch) {return _read(${name}, ${name}_tex, pos, ch);}
        vec4 ${name}_read01(vec2 pos, float ch) {return _read01(${name}, ${name}_tex, pos, ch);}
        vec4 ${name}_readUV(vec2 uv) {return _readUV(${name}, ${name}_tex, uv);}
    `
}

const PREFIX = `
    precision highp float;

    // "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW)
    float hash13(vec3 p3) {
      p3  = fract(p3 * .1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    vec2 hash23(vec3 p3)
    {
        p3 = fract(p3 * vec3(.1031, .1030, .0973));
        p3 += dot(p3, p3.yzx+33.33);
        return fract((p3.xx+p3.yz)*p3.zy);
    }

    struct Tensor {
        vec2 size;
        vec2 gridSize;
        float depth, depth4;
        vec2 packScaleZero;
    };
    uniform Tensor u_output;

    vec4 _readUV(Tensor tensor, sampler2D tex, vec2 uv) {
        vec4 v = texture2D(tex, uv);
        vec2 p = tensor.packScaleZero;
        v = (v-p.y)*p.x;
        return v;
    }
    vec2 _getUV(Tensor tensor, vec2 pos, float ch) {
        ch += 0.5;
        float tx = floor(mod(ch, tensor.gridSize.x));
        float ty = floor(ch / tensor.gridSize.x);
        vec2 cell = mod(floor(pos), tensor.size) + 0.5;
        vec2 p = cell / tensor.size + vec2(tx, ty);
        p /= tensor.gridSize;
        return p;
    }
    vec4 _read01(Tensor tensor, sampler2D tex, vec2 pos, float ch) {
        return texture2D(tex, _getUV(tensor, pos, ch));
    }
    vec4 _read(Tensor tensor, sampler2D tex, vec2 pos, float ch) {
        vec2 p = _getUV(tensor, pos, ch);
        return _readUV(tensor, tex, p);
    }
    vec2 getOutputXY() {
        return mod(gl_FragCoord.xy, u_output.size);
    }
    float getOutputChannel() {
        vec2 xy = floor(gl_FragCoord.xy/u_output.size);
        return xy.y*u_output.gridSize.x+xy.x;
    }

    void setOutput(vec4 v) {
        vec2 p = u_output.packScaleZero;
        v = v/p.x + p.y;
        gl_FragColor = v;
    }

    #ifdef SPARSE_UPDATE
        uniform sampler2D u_shuffleTex, u_unshuffleTex;
        uniform vec2 u_shuffleOfs;
    #endif

    ${defInput('u_input')}

    uniform float u_angle, u_alignment;
    uniform float u_hexGrid;
    
    mat2 rotate(float ang) {
        float s = sin(ang), c = cos(ang);
        return mat2(c, s, -s, c);
    }

    vec2 getCellDirection(vec2 xy) {
        vec2 dir = vec2(0.0, 1.0);
        if (u_alignment == 1.0) {
            dir = normalize(xy-0.5*u_input.size);
        } else if (u_alignment == 2.0) {
            vec2 v1 = xy-0.25*u_input.size;
            vec2 v2 = 0.75*u_input.size-xy;
            dir = normalize(v1/pow(length(v1), 3.0) +  v2/pow(length(v2), 3.0));
        }
        dir = rotate(u_angle) * dir;
        return dir;
    }
    // https://www.shadertoy.com/view/Xljczw
    // https://www.shadertoy.com/view/MlXyDl
    // returns xy - in cell pos, zw - skewed cell id
    vec4 getHex(vec2 u) {
        vec2 s = vec2(1., mix(2.0, 1.732, u_hexGrid));
        vec2 p = vec2(0.5*u_hexGrid, 0.5);
        vec2 a = mod(u    ,s)*2.-s;
        vec2 b = mod(u+s*p,s)*2.-s;
        vec2 ai = floor(u/s);
        vec2 bi = floor(u/s+p);
        // skewed coords
        ai = vec2(ai.x-ai.y*u_hexGrid, ai.y*2.0+1.0);
        bi = vec2(bi.x-bi.y*u_hexGrid, bi.y*2.0);
        return dot(a,a)<dot(b,b) ? vec4(a, ai) : vec4(b, bi);    
    }

    vec2 hex2screen(vec2 u) {
        return vec2(u.x + u.y/2.0, u.y*1.732/2.0); 
    }
`;

const PROGRAMS = {
    paint: `
    uniform vec2 u_pos;
    uniform float u_r;
    uniform vec4 u_brush;
    uniform float u_zoom;

    void main() {

        vec2 xy = u_pos;
        xy = (xy + u_output.size*(0.5)*(u_zoom-1.0))/u_zoom;
        vec2 xy_out = getOutputXY();
        if (u_hexGrid > 0.0) {
            // vec4 r = getHex(u_pos - u_output.size*0.5);
            // xy = r.zw + u_output.size*0.5;
            xy_out = hex2screen(xy_out - u_output.size*0.5);
            xy_out = xy_out + u_output.size*0.5;
        }
        vec2 diff = abs(xy_out-xy);
        diff = min(diff, u_output.size-diff);
        if (length(diff)*u_zoom>=u_r) 
          discard;
        setOutput(u_brush);

    }`,
    perception: `
    const mat3 sobelX = mat3(-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0)/8.0;
    const mat3 sobelY = mat3(-1.0,-2.0,-1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 1.0)/8.0;
    const mat3 gauss = mat3(1.0, 2.0, 1.0, 2.0, 4.0-16.0, 2.0, 1.0, 2.0, 1.0)/8.0;
    const mat3 sobelXhex = mat3( 0.0,    -1.0, 1.0, 
                                       -2.0, 0.0, 2.0, 
                                         -1.0, 1.0,        0.0)/8.0;

    const mat3 sobelYhex = mat3( 0.0,    -2.0,-2.0, 
                                        0.0, 0.0, 0.0, 
                                          2.0, 2.0,        0.0)/8.0;

    const mat3 gaussHex = mat3(0.0,       2.0, 2.0, 
                                       2.0, 4.0-16.0, 2.0, 
                                          2.0, 2.0,        0.0)/8.0;

    vec4 conv3x3(vec2 xy, float inputCh, mat3 filter) {
        vec4 a = vec4(0.0);
        for (int y=0; y<3; ++y)
        for (int x=0; x<3; ++x) {
          vec2 p = xy+vec2(float(x-1), float(y-1));
          a += filter[y][x] * u_input_read(p, inputCh);
        }
        return a;
    }

    void main() {
        vec2 xy = getOutputXY();
        #ifdef SPARSE_UPDATE
            xy = texture2D(u_shuffleTex, xy/u_output.size).xy*255.0+0.5 + u_shuffleOfs;
            xy = mod(xy, u_input.size);
        #endif
        float ch = getOutputChannel();
        if (ch >= u_output.depth4)
            return;

        float filterBand = floor((ch+0.5)/u_input.depth4);
        float inputCh = ch-filterBand*u_input.depth4;
        if (filterBand < 0.5) {
            setOutput(u_input_read(xy, inputCh));
        } else if (filterBand < 2.5) {
            vec4 dx = conv3x3(xy, inputCh, sobelX*(1.0-u_hexGrid) + sobelXhex*u_hexGrid);
            vec4 dy = conv3x3(xy, inputCh, sobelY*(1.0-u_hexGrid) + sobelYhex*u_hexGrid);
            vec2 dir = getCellDirection(xy);
            float s = dir.x, c = dir.y;
            setOutput(filterBand < 1.5 ? dx*c-dy*s : dx*s+dy*c);
        } else {
            setOutput(conv3x3(xy, inputCh, gauss*(1.0-u_hexGrid) + gaussHex*u_hexGrid));
        }
    }`,
    dense: `
    ${defInput('u_control')}
    uniform sampler2D u_weightTex;
    uniform float u_seed, u_fuzz;
    uniform vec2 u_weightCoefs; // scale, center
    uniform vec2 u_layout;
    uniform float u_applyRelu;
    
    const float MAX_PACKED_DEPTH = 32.0;
    
    vec4 readWeightUnscaled(vec2 p) {
        vec4 w = texture2D(u_weightTex, p);
        return w-u_weightCoefs.y;
    }
    
    void main() {
      vec2 xy = getOutputXY();
      float ch = getOutputChannel();
      if (ch >= u_output.depth4)
          return;

      float dy = 1.0/(u_input.depth+1.0)/u_layout.y;
      vec2 p = vec2((ch+0.5)/u_output.depth4, dy*0.5);
      vec2 fuzz = (hash23(vec3(xy, u_seed+ch))-0.5)*u_fuzz;

      vec2 realXY = xy;
      #ifdef SPARSE_UPDATE
        realXY = texture2D(u_shuffleTex, xy/u_output.size).xy*255.0+0.5 + u_shuffleOfs;
      #endif
      float modelIdx = u_control_read(realXY+fuzz, 0.0).x+0.5;
      p.x += floor(mod(modelIdx, u_layout.x));
      p.y += floor(modelIdx/u_layout.x);
      p /= u_layout;
      vec4 result = vec4(0.0);
      for (float i=0.0; i < MAX_PACKED_DEPTH; i+=1.0) {
          vec4 inVec = u_input_read(xy, i);
          result += inVec.x * readWeightUnscaled(p); p.y += dy;
          result += inVec.y * readWeightUnscaled(p); p.y += dy;
          result += inVec.z * readWeightUnscaled(p); p.y += dy;
          result += inVec.w * readWeightUnscaled(p); p.y += dy;
          if (i+1.5>u_input.depth4) {
              break;
          }
      }
      result += readWeightUnscaled(p);  // bias
      if (u_applyRelu > 0.5) {
          result = max(result, vec4(0.0));
      }
      setOutput(result*u_weightCoefs.x);
    }`,
    update: `
    ${defInput('u_update')}
    uniform float u_seed, u_updateProbability;

    varying vec2 uv;

    void main() {
      vec2 xy = getOutputXY();
    //   if (xy.y>100.0 && xy.y < 150.0) {
    //       xy.x -= 1.0;
    //   }
      float ch = getOutputChannel();
      vec4 state = u_input_read(xy, ch); //u_input_readUV(uv);
      vec4 update = vec4(0.0);
      #ifdef SPARSE_UPDATE
        vec4 shuffleInfo = texture2D(u_unshuffleTex, fract((xy-u_shuffleOfs)/u_output.size));
        if (shuffleInfo.z > 0.5) {
            update = u_update_read(shuffleInfo.xy*255.0+0.5, getOutputChannel());
        }
      #else
        if (hash13(vec3(xy, u_seed)) <= u_updateProbability) {
            update = u_update_readUV(uv);    
        }
      #endif
      setOutput(state + update);
    }`,
    vis: `
    uniform float u_raw;
    uniform float u_zoom;
    uniform float u_perceptionCircle, u_arrows;
    varying vec2 uv;

    float clip01(float x) {
        return min(max(x, 0.0), 1.0);
    }

    const float PI = 3.141592653;

    float peak(float x, float r) {
        float y = x/r;
        return exp(-y*y);
    }

    float getElement(vec4 v, float i) {
        if (i<1.0) return v.x;
        if (i<2.0) return v.y;
        if (i<3.0) return v.z;
        return v.w;
    }

    vec3 onehot3(float i) {
        if (i<1.0) return vec3(1.0, 0.0, 0.0);
        if (i<2.0) return vec3(0.0, 1.0, 0.0);
        return vec3(0.0, 0.0, 1.0);
    }

    float sdTriangleIsosceles( in vec2 p, in vec2 q ) {
        p.x = abs(p.x);
        vec2 a = p - q*clamp( dot(p,q)/dot(q,q), 0.0, 1.0 );
        vec2 b = p - q*vec2( clamp( p.x/q.x, 0.0, 1.0 ), 1.0 );
        float s = -sign( q.y );
        vec2 d = min( vec2( dot(a,a), s*(p.x*q.y-p.y*q.x) ),
                      vec2( dot(b,b), s*(p.y-q.y)  ));
        return -sqrt(d.x)*sign(d.y);
    }
    

    void main() {
        vec2 xy = vec2(uv.x, 1.0-uv.y);
        if (u_raw > 0.5) {
            gl_FragColor = texture2D(u_input_tex, xy);
            gl_FragColor.a = 1.0;
        } else {
            xy = (xy + vec2(0.5)*(u_zoom-1.0))/u_zoom;
            xy *= u_input.size;
            vec2 fp = 2.0*fract(xy)-1.0;

            if (u_hexGrid > 0.0) {
                vec4 r = getHex(xy-u_input.size*0.5);
                xy = r.zw+u_input.size*0.5;
                fp = r.xy;
            }

            vec3 cellRGB = u_input_read(xy, 0.0).rgb/2.0+0.5;
            vec3 rgb = cellRGB;
            if (3.0 < u_zoom) {
                vec2 dir = getCellDirection(floor(xy)+0.5);
                float s = dir.x, c = dir.y;
                fp = mat2(c, s, -s, c) * fp;    
                float r = length(fp);
                float fade = clip01((u_zoom-3.0)/3.0);
                float m = 1.0;//1.0-min(r*r*r, 1.0)*fade;
                rgb *= m;
                if (12.0 < u_zoom) {
                    float ang = atan(-fp.x, fp.y)/(2.0*PI)+0.5;
                    float ch = mod(ang*u_input.depth+1.5, u_input.depth);
                    float barLengh = 0.0;
                    vec3 barColor = vec3(0.5);
                    if (ch < 3.0) {
                        vec3 i3 = onehot3(ch);
                        barColor = i3;
                        barLengh = dot(cellRGB, i3);
                    } else {
                        vec4 v4 = u_input_read01(xy, floor(ch/4.0));
                        barLengh = getElement(v4, mod(ch, 4.0));
                    }

                    float c = mod(ch, 1.0);
                    c = peak(c-0.5, 0.2);
                    if (r>barLengh)
                      c = 0.0;
                    float fade = clip01((u_zoom-12.0)/8.0);
                    c *= fade;
                    rgb += barColor*c;

                    float arrow = sdTriangleIsosceles((fp+vec2(0.0, 0.95))*vec2(4.0, 4.0), vec2(1.0, 1.0));
                    arrow = clip01(1.0-abs(arrow)*u_zoom/4.0);
                    rgb += arrow*fade*u_arrows;

                    float cr = length(u_input.size/2.0-0.5-xy);
                    rgb += peak(cr-1.5, 0.5/u_zoom)*fade*u_perceptionCircle;
                }
            } 

            gl_FragColor = vec4(rgb, 1.0);
        }
    }`
}

function createPrograms(gl, defines) {
    defines = defines || '';
    const res = {};
    for (const name in PROGRAMS) {
        const fs_code = defines + PREFIX + PROGRAMS[name];
        const progInfo = twgl.createProgramInfo(gl, [vs_code, fs_code]);
        progInfo.name = name;
        res[name] = progInfo;
    }
    return res;
}

function createTensor(gl, w, h, depth, packScaleZero) {
    const depth4 = Math.ceil(depth / 4);
    const gridW = Math.ceil(Math.sqrt(depth4));
    const gridH = Math.floor((depth4 + gridW - 1) / gridW);
    const texW = w * gridW, texH = h * gridH;

    const attachments = [{ minMag: gl.NEAREST }];
    const fbi = twgl.createFramebufferInfo(gl, attachments, texW, texH);
    const tex = fbi.attachments[0];
    return {
        _type: 'tensor',
        fbi, w, h, depth, gridW, gridH, depth4, tex, texW, texH, packScaleZero
    };
}

function setTensorUniforms(uniforms, name, tensor) {
    uniforms[name + '.size'] = [tensor.w, tensor.h];
    uniforms[name + '.gridSize'] = [tensor.gridW, tensor.gridH];
    uniforms[name + '.depth'] = tensor.depth;
    uniforms[name + '.depth4'] = tensor.depth4;
    uniforms[name + '.packScaleZero'] = tensor.packScaleZero;
    if (name != 'u_output') {
        uniforms[name + '_tex'] = tensor.tex;
    }
}

function createDenseInfo(gl, params) {
    const coefs = [params.scale, 127.0 / 255.0];
    const [in_n, out_n] = params.shape;
    const info = { coefs, layout: params.layout, in_n: in_n - 1, out_n,
        quantScaleZero: params.quant_scale_zero, ready: false };
    info.tex = twgl.createTexture(gl, {
        minMag: gl.NEAREST, src: params.data, flipY: false, premultiplyAlpha: false,
    }, ()=>{
        info.ready = true;
    });
    return info;
}

export class CA {
    constructor(gl, models, gridSize, gui) {
        self = this;
        this.gl = gl;
        this.gridSize = gridSize || [96, 96];

        this.updateProbability = 0.5;
        this.shuffledMode = true;

        this.rotationAngle = 0.0;
        this.alignment = 0;
        this.fuzz = 8.0;
        this.perceptionCircle = 0.0;
        this.arrowsCoef = 0.0;
        this.visMode = 'color';
        this.hexGrid = false;
 
        this.layers = [];
        this.setWeights(models);

        this.progs = createPrograms(gl, this.shuffledMode ? '#define SPARSE_UPDATE\n' : '');
        this.quad = twgl.createBufferInfoFromArrays(gl, {
            position: [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0],
        });

        this.setupBuffers();
        const visNames = Object.getOwnPropertyNames(this.buf);
        visNames.push('color');

        if (gui) {
            gui.add(this, 'rotationAngle').min(0.0).max(360.0);
            gui.add(this, 'alignment', { cartesian: 0, polar: 1, bipolar: 2 }).listen();
            //gui.add(this, 'fuzz').min(0.0).max(128.0);
            //gui.add(this, 'perceptionCircle').min(0.0).max(1.0);
            //gui.add(this, 'visMode', visNames);
            gui.add(this, 'hexGrid');
        }

        this.clearCircle(0, 0, 10000);
    }

    setupBuffers() {
        const gl = this.gl;
        const [gridW, gridH] = this.gridSize;
        const shuffleH = Math.ceil(gridH * this.updateProbability);
        const shuffleCellN = shuffleH * gridW;
        const totalCellN = gridW * gridH;
        const shuffleBuf = new Uint8Array(shuffleCellN * 4);
        const unshuffleBuf = new Uint8Array(totalCellN * 4);
        let k = 0;
        for (let i = 0; i < totalCellN; ++i) {
            if (Math.random() < (shuffleCellN - k) / (totalCellN - i)) {
                shuffleBuf[k * 4 + 0] = i % gridW;
                shuffleBuf[k * 4 + 1] = Math.floor(i / gridW);
                unshuffleBuf[i * 4 + 0] = k % gridW;
                unshuffleBuf[i * 4 + 1] = Math.floor(k / gridW);
                unshuffleBuf[i * 4 + 2] = 255;
                k += 1;
            }
        }        
        this.shuffleTex = twgl.createTexture(gl, { minMag: gl.NEAREST, width: gridW, height: shuffleH, src: shuffleBuf});
        this.unshuffleTex = twgl.createTexture(gl, { minMag: gl.NEAREST, width: gridW, height: gridH, src: unshuffleBuf});
        this.shuffleOfs = [0, 0];

        const updateH = this.shuffledMode ? shuffleH : gridH;
        const perception_n = this.layers[0].in_n;
        const lastLayer = this.layers[this.layers.length-1];
        const channel_n = lastLayer.out_n;
        const stateQuantization = lastLayer.quantScaleZero;
        this.buf = {
            control: createTensor(gl, gridW, gridH, 4, [255.0, 0.0]),
            state: createTensor(gl, gridW, gridH, channel_n, stateQuantization),
            newState: createTensor(gl, gridW, gridH, channel_n, stateQuantization),
            perception: createTensor(gl, gridW, updateH, perception_n, stateQuantization),
        };
        for (let i=0; i<this.layers.length; ++i) {
            const layer = this.layers[i];
            this.buf[`layer${i}`] = createTensor(gl, gridW, updateH, layer.out_n, layer.quantScaleZero);
        }
    }

    step(stage) {
        stage = stage || 'all';
        if (!this.layers.every(l=>l.ready)) 
            return;
    
        if (stage == 'all') {
            const [gridW, gridH] = this.gridSize;
            this.shuffleOfs = [Math.floor(Math.random() * gridW), Math.floor(Math.random() * gridH)];
        }
        
        if (stage == 'all' || stage == 'perception') {
            this.runLayer(self.progs.perception, this.buf.perception, {
                u_input: this.buf.state, u_angle: this.rotationAngle / 180.0 * Math.PI,
                u_alignment: this.alignment, u_hexGrid: this.hexGrid
            });
        }
        let inputBuf = this.buf.perception;
        for (let i=0; i<this.layers.length; ++i) {
            if (stage == 'all' || stage == `layer${i}`)
                this.runDense(this.buf[`layer${i}`], inputBuf, this.layers[i]);
            inputBuf = this.buf[`layer${i}`];
        }
        if (stage == 'all' || stage == 'newState') {
            this.runLayer(this.progs.update, this.buf.newState, {
                u_input: this.buf.state, u_update: inputBuf,
                u_unshuffleTex: this.unshuffleTex,
                u_seed: Math.random() * 1000, u_updateProbability: this.updateProbability
            });
        }

        if (stage == 'all') {
            [this.buf.state, this.buf.newState] = [this.buf.newState, this.buf.state];
        }
    }

    benchmark() {
        const gl = this.gl;
        const flushBuf = new Uint8Array(4);
        const flush = buf=>{
            buf = buf || this.buf.state;
            // gl.flush/finish don't seem to do anything, so reading a single 
            // pixel from the state buffer to flush the GPU command pipeline
            twgl.bindFramebufferInfo(gl, buf.fbi);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, flushBuf);
        }

        flush();
        const stepN = 100;
        const start = Date.now();
        for (let i = 0; i < stepN; ++i)
            this.step();
        flush();
        const total = (Date.now() - start) / stepN;

        const ops = ['perception'];
        for (let i=0; i<this.layers.length; ++i)
            ops.push(`layer${i}`);
        ops.push('newState');
        let perOpTotal = 0.0;
        const perOp = [];
        for (const op of ops) {
            const start = Date.now();
            for (let i = 0; i < stepN; ++i) {
                this.step(op);
            }
            flush(this.buf[op]);
            const dt = (Date.now() - start) / stepN;
            perOpTotal += dt
            perOp.push([op, dt]);
        }
        const perOpStr = perOp.map((p) => {
            const [programName, dt] = p;
            const percent = 100.0 * dt / perOpTotal;
            return `${programName}: ${percent.toFixed(1)}%`;
        }).join(', ');
        return `${(total).toFixed(2)} ms/step, ${(1000.0 / total).toFixed(2)} step/sec\n` + perOpStr + '\n\n';
    }

    paint(x, y, r, brush) {
        this.runLayer(this.progs.paint, this.buf.control, {
            u_pos: [x, y], u_r: r, u_brush: [brush, 0, 0, 0], u_hexGrid: this.hexGrid, u_zoom: 1.0 
        });
    }

    clearCircle(x, y, r, brush, zoom=1.0) {
        self.runLayer(self.progs.paint, this.buf.state, {
            u_pos: [x, y], u_r: r, u_brush: [0, 0, 0, 0], u_hexGrid: this.hexGrid, u_zoom: zoom
        });
    }

    setWeights(models) {
        const gl = this.gl;
        this.layers.forEach(layer=>gl.deleteTexture(layer));
        this.layers = models.layers.map(layer=>createDenseInfo(gl, layer));
    }

    runLayer(program, output, inputs) {
        const gl = this.gl;
        inputs = inputs || {};
        const uniforms = {};
        for (const name in inputs) {
            const val = inputs[name];
            if (val._type == 'tensor') {
                setTensorUniforms(uniforms, name, val);
            } else {
                uniforms[name] = val;
            }
        }
        uniforms['u_shuffleTex'] = this.shuffleTex;
        uniforms['u_shuffleOfs'] = this.shuffleOfs;
        setTensorUniforms(uniforms, 'u_output', output);

        twgl.bindFramebufferInfo(gl, output.fbi);
        gl.useProgram(program.program);
        twgl.setBuffersAndAttributes(gl, program, this.quad);
        twgl.setUniforms(program, uniforms);
        twgl.drawBufferInfo(gl, this.quad);
        return { programName: program.name, output }
    }

    runDense(output, input, layer) {
        return this.runLayer(this.progs.dense, output, {
            u_input: input, u_control: this.buf.control,
            u_weightTex: layer.tex, u_weightCoefs: layer.coefs, u_layout: layer.layout,
            u_seed: Math.random() * 1000, u_fuzz: this.fuzz
        });
    }

    draw(zoom) {
        const gl = this.gl;
        zoom = zoom || 1.0;

        gl.useProgram(this.progs.vis.program);
        twgl.setBuffersAndAttributes(gl, this.progs.vis, this.quad);
        const uniforms = { u_raw: 0.0, u_zoom: zoom,
            u_angle: this.rotationAngle / 180.0 * Math.PI,
            u_alignment: this.alignment,
            u_perceptionCircle: this.perceptionCircle,
            u_arrows: this.arrowsCoef,
            u_hexGrid: this.hexGrid,
        };
        let inputBuf = this.buf.state;
        if (this.visMode != 'color') {
            inputBuf = this.buf[this.visMode];
            uniforms.u_raw = 1.0;
        }
        setTensorUniforms(uniforms, 'u_input', inputBuf);
        twgl.setUniforms(this.progs.vis, uniforms);
        twgl.drawBufferInfo(gl, this.quad);
    }
}

function createProgramSet(gl, programs, defines) {
    defines = defines || '';
    const result = {};
    for (const name in programs) {
        const fsCode = defines + PREFIX + programs[name];
        const progInfo = twgl.createProgramInfo(gl, [vs_code, fsCode]);
        progInfo.name = name;
        result[name] = progInfo;
    }
    return result;
}

function clampByte(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function normalizeBits(bits, count) {
    const normalized = new Array(count).fill(0);
    if (!Array.isArray(bits)) {
        return normalized;
    }
    for (let i = 0; i < Math.min(bits.length, count); ++i) {
        normalized[i] = bits[i] ? 1 : 0;
    }
    return normalized;
}

function encodeValue(value, scale, zero) {
    return clampByte((value / scale + zero) * 255.0);
}

function buildDenseLayerTexture(gl, layer) {
    const weights = layer.weights || [];
    const bias = layer.bias || [];
    const outChannels = layer.out_channels || weights.length;
    const inChannels = layer.in_channels || (weights[0] ? weights[0].length : 0);
    const outDepth4 = Math.ceil(outChannels / 4);
    const texWidth = outDepth4;
    const texHeight = inChannels + 1;
    const maxAbs = Math.max(
        1e-6,
        ...weights.flat().map(v => Math.abs(v)),
        ...bias.map(v => Math.abs(v))
    );
    const scale = layer.weight_scale || (maxAbs * 2.0);
    const zero = 127.0 / 255.0;
    const texData = new Uint8Array(texWidth * texHeight * 4);
    const writeTexel = (x, y, rgba) => {
        const idx = (y * texWidth + x) * 4;
        texData[idx + 0] = encodeValue(rgba[0], scale, zero);
        texData[idx + 1] = encodeValue(rgba[1], scale, zero);
        texData[idx + 2] = encodeValue(rgba[2], scale, zero);
        texData[idx + 3] = encodeValue(rgba[3], scale, zero);
    };

    for (let inputIdx = 0; inputIdx < inChannels; ++inputIdx) {
        for (let pack = 0; pack < outDepth4; ++pack) {
            const rgba = [0, 0, 0, 0];
            for (let component = 0; component < 4; ++component) {
                const outIdx = pack * 4 + component;
                if (outIdx < outChannels) {
                    rgba[component] = weights[outIdx][inputIdx] || 0.0;
                }
            }
            writeTexel(pack, inputIdx, rgba);
        }
    }

    for (let pack = 0; pack < outDepth4; ++pack) {
        const rgba = [0, 0, 0, 0];
        for (let component = 0; component < 4; ++component) {
            const outIdx = pack * 4 + component;
            if (outIdx < outChannels) {
                rgba[component] = bias[outIdx] || 0.0;
            }
        }
        writeTexel(pack, inChannels, rgba);
    }

    return {
        tex: twgl.createTexture(gl, {
            minMag: gl.NEAREST,
            width: texWidth,
            height: texHeight,
            src: texData,
            format: gl.RGBA,
            internalFormat: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            flipY: false,
            premultiplyAlpha: false,
        }),
        coefs: [scale, zero],
        in_n: inChannels,
        out_n: outChannels,
        layout: [1, 1],
        activation: layer.activation || null,
        quantScaleZero: [
            layer.output_scale || layer.quant_scale || 16.0,
            zero,
        ],
        ready: true,
    };
}

function setTextureBytes(gl, tensor, bytes) {
    gl.bindTexture(gl.TEXTURE_2D, tensor.tex);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        tensor.texW,
        tensor.texH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes
    );
}

const GENOMIC_PROGRAMS = {
    perception: `
    const mat3 ident = mat3(
        0.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 0.0
    );
    const mat3 sobelX = mat3(
        -1.0, 0.0, 1.0,
        -2.0, 0.0, 2.0,
        -1.0, 0.0, 1.0
    );
    const mat3 sobelY = mat3(
        -1.0, -2.0, -1.0,
         0.0,  0.0,  0.0,
         1.0,  2.0,  1.0
    );
    const mat3 lap = mat3(
         1.0,  2.0,  1.0,
         2.0, -12.0, 2.0,
         1.0,  2.0,  1.0
    );

    vec4 conv3x3(vec2 xy, float inputCh, mat3 filter) {
        vec4 a = vec4(0.0);
        for (int y=0; y<3; ++y)
        for (int x=0; x<3; ++x) {
          vec2 p = xy+vec2(float(x-1), float(y-1));
          a += filter[y][x] * u_input_read(p, inputCh);
        }
        return a;
    }

    void main() {
        vec2 xy = getOutputXY();
        float ch = getOutputChannel();
        if (ch >= u_output.depth4)
            return;

        float filterBand = floor((ch + 0.5) / u_input.depth4);
        float inputCh = ch - filterBand * u_input.depth4;
        if (filterBand < 0.5) {
            setOutput(conv3x3(xy, inputCh, ident));
        } else if (filterBand < 1.5) {
            setOutput(conv3x3(xy, inputCh, sobelX));
        } else if (filterBand < 2.5) {
            setOutput(conv3x3(xy, inputCh, sobelY));
        } else {
            setOutput(conv3x3(xy, inputCh, lap));
        }
    }`,
    dense: PROGRAMS.dense,
    vis: `
    uniform float u_raw;
    uniform float u_zoom;
    varying vec2 uv;

    void main() {
        vec2 xy = vec2(uv.x, 1.0 - uv.y);
        if (u_raw > 0.5) {
            gl_FragColor = texture2D(u_input_tex, xy);
            gl_FragColor.a = 1.0;
            return;
        }

        xy = (xy + vec2(0.5) * (u_zoom - 1.0)) / u_zoom;
        xy *= u_input.size;
        vec3 rgb = u_input_read(xy, 0.0).rgb + vec3(0.5);
        gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
    }`,
    update: `
    ${defInput('u_update')}
    uniform float u_seed, u_updateProbability;

    varying vec2 uv;

    void main() {
      vec2 xy = getOutputXY();
      float ch = getOutputChannel();
      vec4 state = u_input_read(xy, ch);
      vec4 delta = vec4(0.0);
      if (hash13(vec3(xy, u_seed)) <= u_updateProbability) {
          delta = u_update_readUV(uv);
      }

      setOutput(state + delta);
    }`,
    brush: `
    uniform vec2 u_pos;
    uniform float u_r;
    uniform float u_resetState;
    uniform float u_writeGenome;
    uniform float u_clearGenome;
    uniform float u_noiseAmount;
    uniform float u_randomizeAll;
    uniform float u_genomeStart, u_genomeEnd;
    uniform vec4 u_genomeBits0, u_genomeBits1;

    float getGenomeBit(float idx) {
        if (idx < 0.5) return u_genomeBits0.x;
        if (idx < 1.5) return u_genomeBits0.y;
        if (idx < 2.5) return u_genomeBits0.z;
        if (idx < 3.5) return u_genomeBits0.w;
        if (idx < 4.5) return u_genomeBits1.x;
        if (idx < 5.5) return u_genomeBits1.y;
        if (idx < 6.5) return u_genomeBits1.z;
        return u_genomeBits1.w;
    }

    bool insideBrush(vec2 sampleXY) {
        vec2 diff = abs(sampleXY - u_pos);
        diff = min(diff, u_output.size - diff);
        return length(diff) < u_r;
    }

    void main() {
        vec2 xy = getOutputXY();
        float ch = getOutputChannel();
        vec4 state = u_input_read(xy, ch);

        if (!insideBrush(xy)) {
            setOutput(state);
            return;
        }

        vec4 outState = state;
        float base = ch * 4.0;

        for (int i = 0; i < 4; ++i) {
            float idx = base + float(i);
            bool isGenome = idx >= u_genomeStart && idx < u_genomeEnd;
            float value = i == 0 ? outState.x : (i == 1 ? outState.y : (i == 2 ? outState.z : outState.w));

            if (u_randomizeAll > 0.5) {
                value = (hash13(vec3(xy, idx + 17.0)) - 0.5) * u_noiseAmount;
            } else if (isGenome) {
                if (u_clearGenome > 0.5) {
                    value = 0.0;
                }
                if (u_writeGenome > 0.5) {
                    value = getGenomeBit(idx - u_genomeStart);
                }
            } else {
                if (u_resetState > 0.5) {
                    value = 0.0;
                }
                if (u_noiseAmount > 0.0) {
                    value += (hash13(vec3(xy, idx + 17.0)) - 0.5) * u_noiseAmount;
                }
            }

            if (i == 0) outState.x = value;
            else if (i == 1) outState.y = value;
            else if (i == 2) outState.z = value;
            else outState.w = value;
        }

        setOutput(outState);
    }`,
};

export class GenomicCA {
    constructor(gl, options = {}) {
        this.gl = gl;
        this.gridSize = options.gridSize || [128, 128];
        this.updateProbability = options.updateProbability || 0.5;
        this.rotationAngle = 0.0;
        this.alignment = 0.0;
        this.fuzz = 0.0;
        this.visMode = 'color';
        this.hexGrid = false;
        this.layers = [];
        this.model = null;
        this.genomeChannels = 0;
        this.stateChannels = 0;
        this.hiddenChannels = 0;
        this.stateQuantizationScale = 4.0;
        this.perceptionQuantizationScale = 16.0;
        this.hiddenQuantizationScale = 16.0;

        this.progs = createProgramSet(gl, GENOMIC_PROGRAMS);
        this.quad = twgl.createBufferInfoFromArrays(gl, {
            position: [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0],
        });
    }

    setGridSize(gridSize) {
        this.gridSize = gridSize;
        if (this.model) {
            this.setupBuffers();
            this.clearAll();
        }
    }

    loadModel(model) {
        const gl = this.gl;
        this.model = model;
        this.stateChannels = model.state_channels;
        this.genomeChannels = model.genome_channels || 0;
        this.hiddenChannels = model.hidden_channels || Math.max(0, this.stateChannels - this.genomeChannels - 3);
        this.stateQuantizationScale = model.state_quantization_scale || 4.0;
        this.perceptionQuantizationScale = model.perception_quantization_scale || Math.max(this.stateQuantizationScale * 2.0, 8.0);
        this.hiddenQuantizationScale = model.hidden_quantization_scale || Math.max(this.stateQuantizationScale * 2.0, 8.0);
        this.updateProbability = model.update_probability || this.updateProbability;
        this.layers.forEach(layer => gl.deleteTexture(layer.tex));
        this.layers = (model.layers || []).map(layer => buildDenseLayerTexture(gl, layer));
        this.setupBuffers();
        this.clearAll();
    }

    setupBuffers() {
        const gl = this.gl;
        const [gridW, gridH] = this.gridSize;
        const zero = 127.0 / 255.0;
        const perceptionChannels = this.layers[0].in_n;
        const lastLayer = this.layers[this.layers.length - 1];

        this.buf = {
            control: createTensor(gl, gridW, gridH, 4, [255.0, 0.0]),
            state: createTensor(gl, gridW, gridH, this.stateChannels, [this.stateQuantizationScale, zero]),
            newState: createTensor(gl, gridW, gridH, this.stateChannels, [this.stateQuantizationScale, zero]),
            perception: createTensor(gl, gridW, gridH, perceptionChannels, [this.perceptionQuantizationScale, zero]),
        };

        this.layers.forEach((layer, idx) => {
            this.buf[`layer${idx}`] = createTensor(
                gl,
                gridW,
                gridH,
                layer.out_n,
                [idx === this.layers.length - 1 ? this.stateQuantizationScale : this.hiddenQuantizationScale, zero]
            );
        });

        this.zeroControl();
    }

    zeroControl() {
        if (!this.buf || !this.buf.control) {
            return;
        }
        const zeroBytes = new Uint8Array(this.buf.control.texW * this.buf.control.texH * 4);
        setTextureBytes(this.gl, this.buf.control, zeroBytes);
    }

    clearAll() {
        if (!this.buf || !this.buf.state) {
            return;
        }
        const state = this.createPackedStateBytes();
        setTextureBytes(this.gl, this.buf.state, state);
        setTextureBytes(this.gl, this.buf.newState, state);
    }

    createPackedStateBytes(genomeMap) {
        const tensor = this.buf.state;
        const bytes = new Uint8Array(tensor.texW * tensor.texH * 4);
        const zero = tensor.packScaleZero[1];
        const scale = tensor.packScaleZero[0];
        const defaultByte = encodeValue(0.0, scale, zero);
        bytes.fill(defaultByte);

        if (!genomeMap) {
            return bytes;
        }

        const genomeStart = this.stateChannels - this.genomeChannels;
        for (let y = 0; y < tensor.h; ++y) {
            for (let x = 0; x < tensor.w; ++x) {
                const cell = genomeMap[y * tensor.w + x] || [];
                for (let g = 0; g < this.genomeChannels; ++g) {
                    const absChannel = genomeStart + g;
                    const pack = Math.floor(absChannel / 4);
                    const component = absChannel % 4;
                    const tx = (pack % tensor.gridW) * tensor.w + x;
                    const ty = Math.floor(pack / tensor.gridW) * tensor.h + y;
                    const idx = (ty * tensor.texW + tx) * 4 + component;
                    const genomeValue = Math.max(0.0, Math.min(1.0, Number(cell[g] ?? 0.0)));
                    bytes[idx] = encodeValue(genomeValue, scale, zero);
                }
            }
        }
        return bytes;
    }

    seedGenomeMap(genomeMap) {
        const bytes = this.createPackedStateBytes(genomeMap);
        setTextureBytes(this.gl, this.buf.state, bytes);
        setTextureBytes(this.gl, this.buf.newState, bytes);
    }

    fillGenome(bits) {
        const normalized = normalizeBits(bits, this.genomeChannels);
        const [w, h] = this.gridSize;
        const genomeMap = new Array(w * h).fill(null).map(() => normalized.slice());
        this.seedGenomeMap(genomeMap);
    }

    step(count = 1) {
        if (!this.model || !this.layers.every(layer => layer.ready)) {
            return;
        }
        for (let stepIdx = 0; stepIdx < count; ++stepIdx) {
            this.runLayer(this.progs.perception, this.buf.perception, {
                u_input: this.buf.state,
                u_angle: 0.0,
                u_alignment: 0.0,
                u_hexGrid: 0.0,
            });

            let inputBuf = this.buf.perception;
            for (let i = 0; i < this.layers.length; ++i) {
                this.runDense(this.buf[`layer${i}`], inputBuf, this.layers[i]);
                inputBuf = this.buf[`layer${i}`];
            }

            this.runLayer(this.progs.update, this.buf.newState, {
                u_input: this.buf.state,
                u_update: inputBuf,
                u_seed: Math.random() * 1000,
                u_updateProbability: this.updateProbability,
            });
            [this.buf.state, this.buf.newState] = [this.buf.newState, this.buf.state];
        }
    }

    applyBrush({ x, y, radius, genomeBits, resetState = false, writeGenome = false, clearGenome = false, noiseAmount = 0.0, randomizeAll = false }) {
        const bits = normalizeBits(genomeBits, this.genomeChannels);
        this.runLayer(this.progs.brush, this.buf.newState, {
            u_input: this.buf.state,
            u_pos: [x, y],
            u_r: radius,
            u_resetState: resetState ? 1.0 : 0.0,
            u_writeGenome: writeGenome ? 1.0 : 0.0,
            u_clearGenome: clearGenome ? 1.0 : 0.0,
            u_noiseAmount: noiseAmount,
            u_randomizeAll: randomizeAll ? 1.0 : 0.0,
            u_genomeStart: this.stateChannels - this.genomeChannels,
            u_genomeEnd: this.stateChannels,
            u_genomeBits0: [bits[0] || 0, bits[1] || 0, bits[2] || 0, bits[3] || 0],
            u_genomeBits1: [bits[4] || 0, bits[5] || 0, bits[6] || 0, bits[7] || 0],
        });
        [this.buf.state, this.buf.newState] = [this.buf.newState, this.buf.state];
    }

    damageCircle(x, y, radius) {
        this.applyBrush({
            x,
            y,
            radius,
            noiseAmount: this.stateQuantizationScale,
            randomizeAll: true,
        });
    }

    paintGenome(x, y, radius, genomeBits, mode = 'paint-only') {
        const options = {
            x,
            y,
            radius,
            genomeBits,
            writeGenome: true,
            resetState: mode === 'paint-reset',
            noiseAmount: 0.0,
        };
        this.applyBrush(options);
    }

    eraseCircle(x, y, radius) {
        this.applyBrush({
            x,
            y,
            radius,
            resetState: true,
            clearGenome: true,
        });
    }

    randomDamage(count = 4, radiusMin = 10, radiusMax = 24) {
        const [w, h] = this.gridSize;
        for (let i = 0; i < count; ++i) {
            const radius = radiusMin + Math.random() * (radiusMax - radiusMin);
            this.damageCircle(Math.random() * w, Math.random() * h, radius);
        }
    }

    runLayer(program, output, inputs) {
        const gl = this.gl;
        const uniforms = {};
        for (const name in inputs) {
            const value = inputs[name];
            if (value && value._type === 'tensor') {
                setTensorUniforms(uniforms, name, value);
            } else {
                uniforms[name] = value;
            }
        }
        setTensorUniforms(uniforms, 'u_output', output);
        twgl.bindFramebufferInfo(gl, output.fbi);
        gl.useProgram(program.program);
        twgl.setBuffersAndAttributes(gl, program, this.quad);
        twgl.setUniforms(program, uniforms);
        twgl.drawBufferInfo(gl, this.quad);
    }

    runDense(output, input, layer) {
        return this.runLayer(this.progs.dense, output, {
            u_input: input,
            u_control: this.buf.control,
            u_weightTex: layer.tex,
            u_weightCoefs: layer.coefs,
            u_layout: layer.layout,
            u_applyRelu: layer.activation === 'relu' ? 1.0 : 0.0,
            u_seed: 0.0,
            u_fuzz: 0.0,
        });
    }

    draw(zoom = 1.0) {
        const gl = this.gl;
        gl.useProgram(this.progs.vis.program);
        twgl.setBuffersAndAttributes(gl, this.progs.vis, this.quad);
        const uniforms = {
            u_raw: 0.0,
            u_zoom: zoom,
            u_angle: 0.0,
            u_alignment: 0.0,
            u_perceptionCircle: 0.0,
            u_arrows: 0.0,
            u_hexGrid: 0.0,
        };
        setTensorUniforms(uniforms, 'u_input', this.buf.state);
        twgl.setUniforms(this.progs.vis, uniforms);
        twgl.drawBufferInfo(gl, this.quad);
    }
}
