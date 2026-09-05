/* ============================================================
   FX KIT · v1 · zero dependencies, ~9 KB
   ------------------------------------------------------------
   The motion-kit.css file covers everything that can be
   expressed as a CSS animation. This file covers what cannot:
   real per-frame simulation.

   The difference matters. A CSS transition interpolates between
   two known states on a fixed clock. A spring has no fixed
   duration — it has mass, stiffness and damping, and it is
   still solving when you interrupt it. That is why cursor-
   following and drag-release on high-end sites feel like objects
   and CSS easing feels like a slideshow.

   Everything here:
     - writes only transform / opacity (compositor-safe)
     - runs one shared rAF loop, not one per effect
     - stops itself when prefers-reduced-motion is set
     - degrades to a static, legible page if it never runs

   USAGE
     FX.spring(opts)            -> a solver you step yourself
     FX.pointer()               -> smoothed, normalised cursor
     FX.magnetic(el, opts)      -> element leans toward cursor
     FX.tilt(el, opts)          -> 3D tilt from cursor, sprung
     FX.parallax(el, depth)     -> layer drifts with cursor
     FX.burst(x, y, opts)       -> particles with real ballistics
     FX.preloader(opts)         -> true progress; minDuration paces it
     FX.shaderBg(canvas, opts)  -> WebGL gradient/grain backdrop
   ============================================================ */

(function (global) {
  "use strict";

  var reduce = global.matchMedia
    ? global.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  /* ---------------------------------------------------------
     One loop for the whole page.
     Dozens of independent requestAnimationFrame callbacks is
     the usual reason "smooth" sites stutter — each one forces
     its own style read. Everything here shares this tick.
     --------------------------------------------------------- */
  var tasks = [];
  var running = false;
  var last = 0;

  function tick(now) {
    var dt = Math.min((now - last) / 1000, 0.064); // clamp tab-switch jumps
    last = now;
    for (var i = tasks.length - 1; i >= 0; i--) {
      var keep = true;
      try {
        keep = tasks[i](dt, now) !== false;
      } catch (e) {
        keep = false;              // drop the offender, keep the loop
        if (window.console) console.error("FX task failed:", e);
      }
      if (!keep) tasks.splice(i, 1);
    }
    if (tasks.length) requestAnimationFrame(tick);
    else running = false;
  }

  function add(fn) {
    tasks.push(fn);
    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(tick);
    }
    return function () {
      var i = tasks.indexOf(fn);
      if (i > -1) tasks.splice(i, 1);
    };
  }

  /* ---------------------------------------------------------
     SPRING
     Semi-implicit Euler. Stable at the step sizes a browser
     actually delivers, unlike the explicit form which blows up
     when a frame is late.

       stiffness  how hard it pulls back   (higher = snappier)
       damping    how fast it settles      (higher = less wobble)
       mass       how much it resists      (higher = heavier)

     Useful pairs:
       cursor follow   s 120  d 18   m 1
       magnetic button s 260  d 22   m 1
       heavy card      s  90  d 16   m 1.6
       overshoot pop   s 420  d 14   m 1
     --------------------------------------------------------- */
  function spring(opts) {
    opts = opts || {};
    var s = {
      value: opts.from || 0,
      target: opts.to != null ? opts.to : (opts.from || 0),
      velocity: 0,
      stiffness: opts.stiffness || 120,
      damping: opts.damping || 18,
      mass: opts.mass || 1,
      precision: opts.precision || 0.0008
    };

    s.step = function (dt) {
      var d = s.target - s.value;
      var force = d * s.stiffness;
      var damper = s.velocity * s.damping;
      s.velocity += ((force - damper) / s.mass) * dt;
      s.value += s.velocity * dt;
      if (Math.abs(d) < s.precision && Math.abs(s.velocity) < s.precision) {
        s.value = s.target;
        s.velocity = 0;
        return true;             // settled
      }
      return false;
    };

    s.set = function (v) { s.value = v; s.velocity = 0; return s; };
    return s;
  }

  /* ---------------------------------------------------------
     POINTER
     Normalised to -1..1 from centre, smoothed by two springs.
     Read pointer.x / pointer.y in your own frame callback.
     --------------------------------------------------------- */
  var _pointer = null;

  function pointer() {
    if (_pointer) return _pointer;

    var sx = spring({ stiffness: 90, damping: 16 });
    var sy = spring({ stiffness: 90, damping: 16 });

    var p = {
      x: 0, y: 0,          // smoothed
      rawX: 0, rawY: 0,    // immediate
      active: false
    };

    if (!reduce.matches) {
      global.addEventListener("pointermove", function (e) {
        p.rawX = (e.clientX / global.innerWidth) * 2 - 1;
        p.rawY = (e.clientY / global.innerHeight) * 2 - 1;
        sx.target = p.rawX;
        sy.target = p.rawY;
        p.active = true;
      }, { passive: true });

      global.addEventListener("pointerleave", function () {
        sx.target = 0; sy.target = 0; p.active = false;
      }, { passive: true });

      add(function (dt) {
        sx.step(dt); sy.step(dt);
        p.x = sx.value; p.y = sy.value;
      });
    }

    _pointer = p;
    return p;
  }

  /* ---------------------------------------------------------
     MAGNETIC
     The element leans toward the cursor while it is near, and
     springs home when it leaves. Distance is measured from the
     element's own centre, not the viewport's.
     --------------------------------------------------------- */
  function magnetic(el, opts) {
    if (!el || reduce.matches) return function () {};
    opts = opts || {};
    var radius = opts.radius || 120;
    var pull = opts.pull != null ? opts.pull : 0.34;

    var sx = spring({ stiffness: opts.stiffness || 260, damping: opts.damping || 22 });
    var sy = spring({ stiffness: opts.stiffness || 260, damping: opts.damping || 22 });

    function onMove(e) {
      var r = el.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      var dist = Math.hypot(dx, dy);
      var reach = Math.max(r.width, r.height) / 2 + radius;
      if (dist < reach) {
        var falloff = 1 - dist / reach;
        sx.target = dx * pull * falloff;
        sy.target = dy * pull * falloff;
      } else {
        sx.target = 0; sy.target = 0;
      }
    }

    global.addEventListener("pointermove", onMove, { passive: true });

    var stop = add(function (dt) {
      var a = sx.step(dt), b = sy.step(dt);
      el.style.transform = "translate3d(" + sx.value.toFixed(2) + "px," + sy.value.toFixed(2) + "px,0)";
      if (a && b && sx.target === 0 && sy.target === 0) el.style.transform = "";
    });

    return function () {
      global.removeEventListener("pointermove", onMove);
      stop();
      el.style.transform = "";
    };
  }

  /* ---------------------------------------------------------
     TILT
     Sprung 3D rotation from cursor position over the element.
     Needs perspective on an ancestor.
     --------------------------------------------------------- */
  function tilt(el, opts) {
    if (!el || reduce.matches) return function () {};
    opts = opts || {};
    var max = opts.max || 9;
    var scale = opts.scale || 1;

    var rx = spring({ stiffness: 140, damping: 18 });
    var ry = spring({ stiffness: 140, damping: 18 });

    function onMove(e) {
      var r = el.getBoundingClientRect();
      var nx = (e.clientX - r.left) / r.width - 0.5;
      var ny = (e.clientY - r.top) / r.height - 0.5;
      var inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) { ry.target = nx * max; rx.target = -ny * max; }
      else { ry.target = 0; rx.target = 0; }
    }

    global.addEventListener("pointermove", onMove, { passive: true });

    var stop = add(function (dt) {
      rx.step(dt); ry.step(dt);
      el.style.transform =
        "perspective(900px) rotateX(" + rx.value.toFixed(2) + "deg) rotateY(" +
        ry.value.toFixed(2) + "deg)" + (scale !== 1 ? " scale(" + scale + ")" : "");
    });

    return function () {
      global.removeEventListener("pointermove", onMove);
      stop();
      el.style.transform = "";
    };
  }

  /* ---------------------------------------------------------
     PARALLAX
     Layer drifts against the smoothed cursor. depth is in px of
     travel at full deflection; negative moves the other way.
     --------------------------------------------------------- */
  function parallax(el, depth) {
    if (!el || reduce.matches) return function () {};
    var p = pointer();
    var d = depth == null ? 20 : depth;
    return add(function () {
      el.style.transform =
        "translate3d(" + (-p.x * d).toFixed(2) + "px," + (-p.y * d * 0.6).toFixed(2) + "px,0)";
    });
  }

  /* ---------------------------------------------------------
     BURST
     Particles with actual ballistics — initial velocity, gravity,
     drag, spin, fade. Cheap DOM nodes, removed on settle.
     Pass `html` to throw your own artwork instead of a dot.
     --------------------------------------------------------- */
  function burst(x, y, opts) {
    if (reduce.matches) return;
    opts = opts || {};
    var n = opts.count || 18;
    var host = opts.host || document.body;

    var layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:" +
      (opts.z || 60) + ";";
    host.appendChild(layer);

    var parts = [];
    for (var i = 0; i < n; i++) {
      var el = document.createElement("span");
      if (opts.html) {
        el.innerHTML = opts.html;
        el.style.cssText = "position:absolute;will-change:transform,opacity;";
      } else {
        var size = opts.size || 8;
        el.style.cssText =
          "position:absolute;width:" + size + "px;height:" + size +
          "px;border-radius:50%;background:" + (opts.color || "#ffd75e") +
          ";will-change:transform,opacity;";
      }
      layer.appendChild(el);

      var angle = (-Math.PI / 2) + (Math.random() - 0.5) * (opts.spread || 1.5);
      var speed = (opts.speed || 420) * (0.55 + Math.random() * 0.8);

      parts.push({
        el: el,
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 640,
        life: 0,
        ttl: (opts.ttl || 1.5) * (0.7 + Math.random() * 0.6)
      });
    }

    var gravity = opts.gravity || 1500;
    var drag = opts.drag || 0.86;

    add(function (dt) {
      var alive = 0;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.life > p.ttl) continue;
        alive++;
        p.life += dt;
        p.vy += gravity * dt;
        p.vx *= Math.pow(drag, dt * 60 / 60);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        var fade = 1 - p.life / p.ttl;
        p.el.style.transform =
          "translate3d(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px,0) rotate(" +
          p.rot.toFixed(1) + "deg)";
        p.el.style.opacity = fade < 0 ? 0 : fade.toFixed(3);
      }
      if (!alive) { layer.remove(); return false; }
    });
  }

  /* ---------------------------------------------------------
     PRELOADER
     Real progress, from images actually decoding — not a fake
     timer counting to 100. Resolves even if something 404s, so
     a missing asset can never trap the visitor behind a gate.
     --------------------------------------------------------- */
  function preloader(opts) {
    opts = opts || {};
    // Lazy images are excluded on purpose. They are below the fold
    // by definition, and if a full-screen gate is up they will never
    // enter the viewport - so waiting on them deadlocks the gate on
    // images the gate itself is preventing from loading.
    var srcs = opts.images || [].slice.call(document.images)
      .filter(function (i) { return i.loading !== "lazy"; })
      .map(function (i) { return i.currentSrc || i.src; });
    srcs = srcs.filter(Boolean);

    var total = srcs.length || 1;
    var done = 0;
    var shown = 0;
    var settled = false;

    function bump() {
      done++;
      if (done >= total) finish();
    }

    function finish() { settled = true; }

    srcs.forEach(function (src) {
      var im = new Image();
      im.onload = im.onerror = bump;
      im.src = src;
    });

    // A stalled or blocked request must never hold the visitor
    // hostage, so the cap is enforced by the loop's own clock
    // rather than by a timer that may be throttled or deferred.
    var limit = opts.timeout || 5000;
    var minDuration = opts.minDuration || 0;
    var pace = opts.pace || 4;
    var elapsed = 0;
    var finished = false;

    function complete() {
      if (finished) return true;
      finished = true;
      if (opts.onProgress) opts.onProgress(100);
      if (opts.onDone) opts.onDone();
      return true;
    }

    // requestAnimationFrame does not run in a background or occluded
    // tab, so a gate driven only by the render loop can sit at zero
    // forever for anyone who opens the page in a new tab. This timer
    // is the escape hatch: it does not animate anything, it just
    // guarantees the visitor is never trapped behind the loader.
    setTimeout(complete, minDuration + limit + 1200);

    add(function (dt) {
      if (finished) return false;
      elapsed += dt * 1000;
      if (elapsed > limit) finish();

      // With minDuration set, the clock leads and the assets only
      // hold it back. Letting asset progress drive the number makes
      // the count stall and lurch, because bytes do not arrive at a
      // human-legible rate. Time is the honest thing to animate.
      var target = minDuration
        ? Math.min((elapsed / minDuration) * 100, 100)
        : (done / total) * 100;

      // never claim finished while something is still in flight
      if (!settled) target = Math.min(target, 96);

      shown += (target - shown) * Math.min(dt * pace, 1);
      if (shown > 100) shown = 100;
      if (opts.onProgress) opts.onProgress(shown);

      if (shown >= 99.5 && settled && elapsed >= minDuration) {
        return !complete();
      }
    });
  }

  /* ---------------------------------------------------------
     SHADER BACKGROUND
     A single full-screen fragment shader: two drifting colour
     poles, value noise, grain and a vignette. This is the one
     thing here that genuinely needs the GPU — the same look in
     CSS costs several blurred layers and repaints constantly.

     If WebGL is unavailable it does nothing at all and whatever
     CSS background is behind the canvas simply shows through.
     --------------------------------------------------------- */
  var FRAG = [
    "precision highp float;",
    "uniform vec2  u_res;",
    "uniform float u_time;",
    "uniform vec2  u_ptr;",
    "uniform vec3  u_a;",
    "uniform vec3  u_b;",
    "uniform vec3  u_bg;",
    "uniform float u_grain;",

    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",

    "float noise(vec2 p){",
    "  vec2 i = floor(p), f = fract(p);",
    "  vec2 u = f * f * (3.0 - 2.0 * f);",
    "  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),",
    "             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);",
    "}",

    "void main(){",
    "  vec2 uv = gl_FragCoord.xy / u_res;",
    "  vec2 p  = uv - 0.5;",
    "  p.x *= u_res.x / u_res.y;",

    // two poles drifting on slow, coprime periods so they never
    // visibly repeat their relative positions
    "  vec2 c1 = vec2(sin(u_time * 0.11) * 0.34, cos(u_time * 0.083) * 0.26);",
    "  vec2 c2 = vec2(cos(u_time * 0.067) * 0.40, sin(u_time * 0.094) * 0.30);",
    "  c1 += u_ptr * 0.10;",
    "  c2 -= u_ptr * 0.06;",

    "  float d1 = 1.0 - smoothstep(0.0, 0.92, length(p - c1));",
    "  float d2 = 1.0 - smoothstep(0.0, 0.86, length(p - c2));",

    "  float n = noise(uv * 3.0 + u_time * 0.05) * 0.10;",

    "  vec3 col = u_bg;",
    "  col = mix(col, u_a, clamp(d1 * 0.85 + n, 0.0, 1.0));",
    "  col = mix(col, u_b, clamp(d2 * 0.65 + n, 0.0, 1.0));",

    // vignette
    "  col *= 1.0 - smoothstep(0.42, 1.15, length(p)) * 0.85;",

    // grain, the thing that stops gradients looking like gradients
    "  float g = hash(gl_FragCoord.xy + fract(u_time) * 100.0);",
    "  col += (g - 0.5) * u_grain;",

    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  var VERT =
    "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";

  function hexToRgb(h) {
    h = h.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function shaderBg(canvas, opts) {
    if (!canvas) return function () {};
    opts = opts || {};

    var gl;
    try {
      gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false })
        || canvas.getContext("experimental-webgl");
    } catch (e) { gl = null; }
    if (!gl) return function () {};          // silent, CSS shows through

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    }

    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return function () {};

    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return function () {};
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    var U = {
      res:   gl.getUniformLocation(prog, "u_res"),
      time:  gl.getUniformLocation(prog, "u_time"),
      ptr:   gl.getUniformLocation(prog, "u_ptr"),
      a:     gl.getUniformLocation(prog, "u_a"),
      b:     gl.getUniformLocation(prog, "u_b"),
      bg:    gl.getUniformLocation(prog, "u_bg"),
      grain: gl.getUniformLocation(prog, "u_grain")
    };

    gl.uniform3fv(U.a,  hexToRgb(opts.a  || "#8b3fa8"));
    gl.uniform3fv(U.b,  hexToRgb(opts.b  || "#3a1f6b"));
    gl.uniform3fv(U.bg, hexToRgb(opts.bg || "#0a0710"));
    gl.uniform1f(U.grain, opts.grain == null ? 0.055 : opts.grain);

    // half-resolution is invisible on a soft gradient and costs a
    // quarter of the fill rate; the grain hides the upscale
    var scale = opts.scale || 0.5;

    function resize() {
      var w = Math.max(1, Math.floor(canvas.clientWidth * scale));
      var h = Math.max(1, Math.floor(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(U.res, w, h);
      }
    }
    resize();
    global.addEventListener("resize", resize, { passive: true });

    var p = pointer();
    var t0 = performance.now();
    var visible = true;
    document.addEventListener("visibilitychange", function () {
      visible = !document.hidden;
    });

    // Reduced motion still gets the shader, just frozen — the
    // look survives, the movement does not.
    var frozen = reduce.matches;

    var stop = add(function () {
      if (!visible) return;
      resize();
      gl.uniform1f(U.time, frozen ? 8.0 : (performance.now() - t0) / 1000);
      gl.uniform2f(U.ptr, p.x, p.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (frozen) return false;   // draw once, then stop
    });

    return function () {
      global.removeEventListener("resize", resize);
      stop();
    };
  }

  global.FX = {
    spring: spring,
    pointer: pointer,
    magnetic: magnetic,
    tilt: tilt,
    parallax: parallax,
    burst: burst,
    preloader: preloader,
    shaderBg: shaderBg,
    frame: add,
    reduced: function () { return reduce.matches; }
  };

})(window);
