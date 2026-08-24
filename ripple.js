// Minimal standalone WebGL water-ripple effect.
//
// A real 2D wave-equation height field (ping-pong float textures updated by
// a Laplacian shader — neighbor average -> acceleration -> damped velocity
// -> height), rendered by deriving the field's surface normal and using it
// to refract a background texture, plus a specular highlight from a fixed
// light direction. Same technique used by well-known ripple demos (e.g.
// jquery.ripples, webgl-water) — no dependencies, no jQuery/Three.js.
//
// Returns null if WebGL or renderable float/half-float textures aren't
// available, so callers can degrade gracefully (skip the effect, not break).

const VERTEX_SHADER = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const UPDATE_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D texture;
uniform vec2 delta;
varying vec2 vUv;
void main() {
  vec4 info = texture2D(texture, vUv);
  vec2 dx = vec2(delta.x, 0.0);
  vec2 dy = vec2(0.0, delta.y);
  float average = (
    texture2D(texture, vUv - dx).r +
    texture2D(texture, vUv - dy).r +
    texture2D(texture, vUv + dx).r +
    texture2D(texture, vUv + dy).r
  ) * 0.25;
  info.g += (average - info.r) * 2.0;
  info.g *= 0.99;
  info.r += info.g;
  gl_FragColor = info;
}
`;

const DROP_FRAGMENT_SHADER = `
precision highp float;
const float PI = 3.141592653589793;
uniform sampler2D texture;
uniform vec2 center;
uniform float radius;
uniform float strength;
varying vec2 vUv;
void main() {
  vec4 info = texture2D(texture, vUv);
  float drop = max(0.0, 1.0 - length(center - vUv) / radius);
  drop = 0.5 - cos(drop * PI) * 0.5;
  info.r += drop * strength;
  gl_FragColor = info;
}
`;

const RENDER_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D samplerBackground;
uniform sampler2D samplerRipples;
uniform vec2 delta;
uniform float perturbance;
uniform float normalZ;
varying vec2 vUv;
void main() {
  vec4 info = texture2D(samplerRipples, vUv);
  // normalZ is deliberately << 1: raw per-texel height differences are tiny
  // compared to a fixed z=1, which washes out the normal's xy tilt to near
  // nothing. Scaling z down makes the normal properly sensitive to the
  // actual gradient instead of always reading as "almost flat".
  vec3 normal = normalize(vec3(
    -(texture2D(samplerRipples, vec2(vUv.x + delta.x, vUv.y)).r - info.r),
    -(texture2D(samplerRipples, vec2(vUv.x, vUv.y + delta.y)).r - info.r),
    normalZ
  ));
  vec2 offset = normal.xy * perturbance;
  vec4 color = texture2D(samplerBackground, vUv + offset);

  vec3 lightDir = normalize(vec3(-0.3, 0.4, 0.6));
  float specular = pow(max(0.0, dot(normal, lightDir)), 40.0);
  color.rgb += vec3(specular * 0.85);

  gl_FragColor = color;
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile error: " + info);
  }
  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Program link error: " + gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < uniformCount; i++) {
    const name = gl.getActiveUniform(program, i).name;
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

export function createRippleEffect(canvas, { resolution = 256, perturbance = 0.4, normalZ = 0.15 } = {}) {
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl) return null;

  // Canvas/image sources are top-left origin; WebGL texture v=0 is
  // bottom-left. Without this, any texture uploaded from a <canvas> (our
  // background replica) renders upside down.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const floatExt = gl.getExtension("OES_texture_float");
  const floatLinearExt = gl.getExtension("OES_texture_float_linear");
  const halfFloatExt = gl.getExtension("OES_texture_half_float");
  const halfFloatLinearExt = gl.getExtension("OES_texture_half_float_linear");

  let type;
  if (floatExt && floatLinearExt) type = gl.FLOAT;
  else if (halfFloatExt && halfFloatLinearExt) type = halfFloatExt.HALF_FLOAT_OES;
  else return null;

  let currentPerturbance = perturbance;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  let updateProgram, dropProgram, renderProgram;
  try {
    updateProgram = createProgram(gl, VERTEX_SHADER, UPDATE_FRAGMENT_SHADER);
    dropProgram = createProgram(gl, VERTEX_SHADER, DROP_FRAGMENT_SHADER);
    renderProgram = createProgram(gl, VERTEX_SHADER, RENDER_FRAGMENT_SHADER);
  } catch {
    return null;
  }

  function createRippleTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, resolution, resolution, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { texture, framebuffer };
  }

  let bufferA = createRippleTexture();
  let bufferB = createRippleTexture();

  const backgroundTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function bindQuad(program) {
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    const loc = gl.getAttribLocation(program.program, "position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  return {
    setBackground(source) {
      gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    },

    addDrop(x, y, radius, strength) {
      gl.viewport(0, 0, resolution, resolution);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.framebuffer);
      bindQuad(dropProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.texture);
      gl.uniform1i(dropProgram.uniforms.texture, 0);
      gl.uniform2f(dropProgram.uniforms.center, x, y);
      gl.uniform1f(dropProgram.uniforms.radius, radius);
      gl.uniform1f(dropProgram.uniforms.strength, strength);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      [bufferA, bufferB] = [bufferB, bufferA];
    },

    update(steps = 1) {
      for (let i = 0; i < steps; i++) {
        gl.viewport(0, 0, resolution, resolution);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bufferB.framebuffer);
        bindQuad(updateProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bufferA.texture);
        gl.uniform1i(updateProgram.uniforms.texture, 0);
        gl.uniform2f(updateProgram.uniforms.delta, 1 / resolution, 1 / resolution);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        [bufferA, bufferB] = [bufferB, bufferA];
      }
    },

    render() {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      bindQuad(renderProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
      gl.uniform1i(renderProgram.uniforms.samplerBackground, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bufferA.texture);
      gl.uniform1i(renderProgram.uniforms.samplerRipples, 1);
      gl.uniform2f(renderProgram.uniforms.delta, 1 / resolution, 1 / resolution);
      gl.uniform1f(renderProgram.uniforms.perturbance, currentPerturbance);
      gl.uniform1f(renderProgram.uniforms.normalZ, normalZ);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    setPerturbance(v) {
      currentPerturbance = v;
    },
  };
}
