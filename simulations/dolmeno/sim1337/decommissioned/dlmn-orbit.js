/*!
 * dlmn-orbit.js — ASCII orbital mesh renderer
 * No dependencies. ES5. ~6 KB unminified.
 *
 *   DLMNOrbit.mount(element, options) -> { start, stop, toggle, destroy, isRunning, ... }
 *
 * Renders a shaded sphere, inclined satellite orbits, dynamic inter-satellite
 * links and a surface ground station into a <pre> as coloured ASCII.
 * Everything shares one z-buffer, so relays and their traces are genuinely
 * occluded by the planet rather than drawn over it.
 */
(function (global) {
  "use strict";

  var RAMP = ".,-~:;=!*#$@";          // darkest -> brightest
  var CLASS = ["", "p", "t", "s", "g"]; // 0 space, 1 planet, 2 trace/link, 3 relay, 4 station

  var DEFAULTS = {
    // --- scene ---
    light:        [-0.80, 0.31, 0.51], // sun direction (unit-ish); lower z = more dramatic crescent
    tilt:         0.36,                // axial tilt, radians
    spinRate:     0.34,                // planet rotation, radians/sec
    nightCutoff:  0.06,                // below this luminance the surface is dark but still occludes
    linkRange:    2.6,                 // max distance for two relays to hold a cross-link
    terrain:      true,                // body-fixed landmasses, so the spin is visible

    // r = orbit radius (planet = 1), inc = inclination, node = ascending node,
    // spd = rad/sec (negative for retrograde), ph = phase at t=0
    satellites: [
      { r: 1.40, inc:  0.44, node: 0.00, spd:  0.95, ph: 0.0 },
      { r: 1.70, inc: -0.31, node: 1.90, spd:  0.68, ph: 2.1 },
      { r: 1.98, inc:  0.57, node: 3.60, spd:  0.51, ph: 4.0 },
      { r: 1.55, inc:  0.09, node: 5.20, spd: -0.79, ph: 1.2 },
      { r: 2.25, inc: -0.50, node: 2.70, spd:  0.40, ph: 5.4 }
    ],
    station: { lat: 0.38, lon: 0.60 },  // rides the surface; null to omit

    // --- grid / sizing ---
    // First entry whose maxWidth the container fits wins. Last entry is the default.
    breakpoints: [
      { maxWidth: 420, cols: 46, rows: 22 },
      { maxWidth: 580, cols: 60, rows: 26 },
      { cols: 78, rows: 26 }
    ],
    radiusRatio: 0.275,  // planet radius as a fraction of grid height
    cellAspect:  2.05,   // monospace cells are ~2x taller than wide
    charAdvance: 0.60,   // advance width as a fraction of font-size, for autosizing
    maxFontSize: 13,
    minFontSize: 4.5,

    // --- behaviour ---
    autoplay:       true,
    pauseOffscreen: true,   // stop the rAF loop when scrolled out of view
    respectReducedMotion: true,
    staticTime:     3.4,    // time of the single frame drawn when motion is reduced
    onStatus:       null    // fn({ relay, links, stationVisible }) each frame
  };

  function assign(target, src) {
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    return target;
  }

  function mount(root, options) {
    if (!root) throw new Error("DLMNOrbit.mount: no element given");
    var o = assign(assign({}, DEFAULTS), options || {});

    var screen = root.querySelector("pre.dlmn-orbit__screen");
    if (!screen) {
      screen = document.createElement("pre");
      screen.className = "dlmn-orbit__screen";
      screen.setAttribute("aria-hidden", "true"); // decorative; don't read the glyph soup out
      root.appendChild(screen);
    }

    var COLS, ROWS, CX, CY, XS, YS, chars, cls, zbuf;
    var ct = Math.cos(o.tilt), stl = Math.sin(o.tilt);
    var sats = o.satellites;

    function layout() {
      var w = root.clientWidth || screen.clientWidth || 600;
      var bp = o.breakpoints[o.breakpoints.length - 1], i;
      for (i = 0; i < o.breakpoints.length; i++) {
        if (o.breakpoints[i].maxWidth == null || w < o.breakpoints[i].maxWidth) { bp = o.breakpoints[i]; break; }
      }
      COLS = bp.cols; ROWS = bp.rows;
      var fs = Math.max(o.minFontSize, Math.min(o.maxFontSize, (w / COLS) / o.charAdvance));
      screen.style.fontSize = fs.toFixed(2) + "px";
      CX = (COLS - 1) / 2;
      CY = (ROWS - 1) / 2;
      YS = ROWS * o.radiusRatio;
      XS = YS * o.cellAspect;
      chars = new Array(COLS * ROWS);
      cls   = new Array(COLS * ROWS);
      zbuf  = new Float32Array(COLS * ROWS);
    }

    function clear() {
      for (var i = 0; i < chars.length; i++) { chars[i] = " "; cls[i] = 0; zbuf[i] = -1e9; }
    }

    // Orthographic projection + z-test. writeZ=true means this pixel also occludes.
    function put(x, y, z, ch, klass, writeZ) {
      var col = Math.round(CX + x * XS);
      var row = Math.round(CY - y * YS);
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
      var i = row * COLS + col;
      if (z <= zbuf[i]) return;
      chars[i] = ch; cls[i] = klass;
      if (writeZ) zbuf[i] = z;
    }

    function tilt(x, y, z) { return [x, y * ct - z * stl, y * stl + z * ct]; }

    function orbitPoint(sat, a) {
      var x = sat.r * Math.cos(a), z = sat.r * Math.sin(a);
      var ci = Math.cos(sat.inc), si = Math.sin(sat.inc);
      var y1 = -z * si, z1 = z * ci;                        // incline the plane
      var cn = Math.cos(sat.node), sn = Math.sin(sat.node); // swing the ascending node
      return tilt(x * cn + z1 * sn, y1, -x * sn + z1 * cn);
    }

    function surfacePoint(lat, lon) {
      var cl = Math.cos(lat);
      return tilt(cl * Math.cos(lon), Math.sin(lat), cl * Math.sin(lon));
    }

    function beam(a, b, ch, klass, steps) {
      for (var i = 1; i < steps; i++) {
        var u = i / steps;
        put(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, ch, klass, false);
      }
    }

    function frame(t) {
      clear();

      // ---- planet ----
      var spin = t * o.spinRate;
      var cs = Math.cos(spin), ss = Math.sin(spin);
      var L = o.light;
      for (var th = 0.05; th < Math.PI; th += 0.045) {
        var st = Math.sin(th), cth = Math.cos(th);
        for (var ph = 0; ph < 6.2832; ph += 0.028) {
          var x0 = st * Math.cos(ph), z0 = st * Math.sin(ph);
          var p = tilt(x0 * cs + z0 * ss, cth, -x0 * ss + z0 * cs);
          if (p[2] < 0) continue;                                  // far hemisphere
          var lum = p[0] * L[0] + p[1] * L[1] + p[2] * L[2];
          if (lum < o.nightCutoff) { put(p[0], p[1], p[2], " ", 0, true); continue; }
          var k = Math.round(lum * (RAMP.length - 1));
          if (o.terrain) {
            // sampled in body-fixed coords, so landmasses ride the rotation
            var terr = Math.sin(3.1 * ph + 1.2) * Math.cos(2.3 * th)
                     + 0.55 * Math.sin(5.7 * ph - 2.0) * Math.sin(3.3 * th);
            k += (terr > 0.30 ? 2 : -1);
          }
          if (k < 0) k = 0; else if (k > RAMP.length - 1) k = RAMP.length - 1;
          put(p[0], p[1], p[2], RAMP.charAt(k), 1, true);
        }
      }

      // ---- orbit traces ----
      for (var s = 0; s < sats.length; s++) {
        for (var a = 0; a < 6.2832; a += 0.09) {
          var q = orbitPoint(sats[s], a);
          put(q[0], q[1], q[2], ".", 2, false);
        }
      }

      var pos = [], m;
      for (m = 0; m < sats.length; m++) pos.push(orbitPoint(sats[m], sats[m].ph + sats[m].spd * t));

      // ---- cross-links: form and break with range ----
      var links = 0;
      for (var i = 0; i < pos.length; i++) {
        for (var j = i + 1; j < pos.length; j++) {
          var dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], dz = pos[i][2] - pos[j][2];
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < o.linkRange) { beam(pos[i], pos[j], ".", 2, Math.ceil(d * 9)); links++; }
        }
      }

      // ---- ground station + uplink ----
      var best = -1, bestD = 9, gs = null;
      if (o.station) {
        gs = surfacePoint(o.station.lat, spin + o.station.lon);
        if (gs[2] > 0.02) {                                        // still on the near side
          for (var k2 = 0; k2 < pos.length; k2++) {
            var ex = pos[k2][0] - gs[0], ey = pos[k2][1] - gs[1], ez = pos[k2][2] - gs[2];
            var ed = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (pos[k2][2] > 0 && ed < bestD) { bestD = ed; best = k2; }
          }
          if (best >= 0) beam(gs, pos[best], ":", 4, Math.ceil(bestD * 10));
          put(gs[0], gs[1], gs[2] + 0.05, "A", 4, false);
        }
      }

      // ---- relays last, so they sit on top of their own traces ----
      for (m = 0; m < pos.length; m++) {
        put(pos[m][0], pos[m][1], pos[m][2], (m === best ? "O" : "o"), 3, false);
      }

      paint();
      if (o.onStatus) o.onStatus({ relay: best < 0 ? null : best + 1, links: links, stationVisible: best >= 0 });
    }

    // Run-length encode each row into spans so we emit ~200 nodes, not ~2000.
    function paint() {
      var out = "", row, c, i, run, klass;
      for (row = 0; row < ROWS; row++) {
        run = ""; klass = cls[row * COLS];
        for (c = 0; c < COLS; c++) {
          i = row * COLS + c;
          if (cls[i] !== klass) {
            out += klass ? ('<span class="' + CLASS[klass] + '">' + run + "</span>") : run;
            run = ""; klass = cls[i];
          }
          run += chars[i];
        }
        out += klass ? ('<span class="' + CLASS[klass] + '">' + run + "</span>") : run;
        if (row < ROWS - 1) out += "\n";
      }
      screen.innerHTML = out;
    }

    // ---- loop ----
    var reduced = o.respectReducedMotion && global.matchMedia
      && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var running = o.autoplay && !reduced;
    var raf = null, base = 0, tNow = 0, observer = null, resizeTimer = null;

    function loop(ts) {
      tNow = ts / 1000 - base;
      frame(tNow);
      if (running) raf = global.requestAnimationFrame(loop);
    }
    function start() {
      if (raf) return;
      running = true;
      raf = global.requestAnimationFrame(function (ts) { base = ts / 1000 - tNow; loop(ts); });
    }
    function stop() {
      running = false;
      if (raf) { global.cancelAnimationFrame(raf); raf = null; }
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { layout(); frame(tNow); }, 140);
    }
    global.addEventListener("resize", onResize);

    if (o.pauseOffscreen && global.IntersectionObserver) {
      observer = new global.IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { if (o.autoplay && !reduced) start(); }
        else if (raf) { global.cancelAnimationFrame(raf); raf = null; }
      }, { threshold: 0.01 });
      observer.observe(root);
    }

    layout();
    if (reduced || !o.autoplay) frame(o.staticTime); else start();

    return {
      start: start,
      stop: stop,
      toggle: function () { if (raf) stop(); else start(); return !!raf; },
      isRunning: function () { return !!raf; },
      seek: function (t) { tNow = t; frame(t); },
      relayout: function () { layout(); frame(tNow); },
      destroy: function () {
        stop();
        clearTimeout(resizeTimer);
        global.removeEventListener("resize", onResize);
        if (observer) observer.disconnect();
        screen.innerHTML = "";
      }
    };
  }

  var api = { mount: mount, defaults: DEFAULTS };
  if (typeof module === "object" && module.exports) module.exports = api;
  global.DLMNOrbit = api;
})(typeof window !== "undefined" ? window : this);
