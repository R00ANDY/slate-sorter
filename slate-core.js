/* Slate Sorter — reading logic shared by the app and the test harness.
 *
 * Works on plain image objects { data: Uint8ClampedArray (RGBA), width, height }.
 * The OCR and barcode engines are passed in, so the same code runs in the browser
 * (tesseract.js + zxing-wasm) and in Node for testing.
 *
 * Slate layout assumptions (fractions of the page, letter portrait, front side):
 *   header block (name, School, Job Name, Subject ID): x 0–0.56, y 0–0.24
 *   studio box barcode:                               x 0.50–1.0, y 0–0.30
 *   red school code:                                  x 0.62–0.92, y 0.185–0.245
 */
(function (root) {
  "use strict";

  // ---------- pixel helpers ----------
  function make(width, height, fill) {
    const data = new Uint8ClampedArray(width * height * 4);
    if (fill !== undefined) data.fill(fill);
    return { data, width, height };
  }

  function crop(img, x0, y0, x1, y1) {
    // fractions (<=1) or pixels
    const fx = (v) => Math.round(v <= 1 ? v * img.width : v);
    const fy = (v) => Math.round(v <= 1 ? v * img.height : v);
    const L = Math.max(0, fx(x0)), T = Math.max(0, fy(y0));
    const R = Math.min(img.width, fx(x1)), B = Math.min(img.height, fy(y1));
    const w = Math.max(1, R - L), h = Math.max(1, B - T);
    const out = make(w, h);
    for (let y = 0; y < h; y++) {
      const src = ((T + y) * img.width + L) * 4;
      out.data.set(img.data.subarray(src, src + w * 4), y * w * 4);
    }
    return out;
  }

  function gray(img) {
    const out = make(img.width, img.height);
    const s = img.data, d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const g = Math.round(0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
    }
    return out;
  }

  function threshold(img, t) {
    const out = make(img.width, img.height);
    const s = img.data, d = out.data;
    for (let i = 0; i < s.length; i += 4) {
      const g = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
      const v = g < t ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    return out;
  }

  // bilinear resize by a scale factor
  function scale(img, f) {
    const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
    const out = make(w, h);
    const s = img.data, d = out.data, sw = img.width, sh = img.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, (y + 0.5) / f - 0.5);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), wy = Math.max(0, sy - y0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, (x + 0.5) / f - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), wx = Math.max(0, sx - x0);
        const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4, i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = s[i00 + c] * (1 - wx) + s[i01 + c] * wx;
          const bot = s[i10 + c] * (1 - wx) + s[i11 + c] * wx;
          d[o + c] = top * (1 - wy) + bot * wy;
        }
        d[o + 3] = 255;
      }
    }
    return out;
  }

  function pad(img, p) {
    const out = make(img.width + 2 * p, img.height + 2 * p, 255);
    for (let y = 0; y < img.height; y++) {
      out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + p) * out.width + p) * 4);
    }
    return out;
  }

  // keep only the red printed ink (school code); everything else becomes white
  function redInk(img) {
    const s = img.data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
    const mask = new Uint8Array(img.width * img.height);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, R = s[i], G = s[i + 1], B = s[i + 2];
        if (R > 140 && G < 120 && B < 120 && R - B > 70) {
          mask[y * img.width + x] = 1; count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (count < 200) return null;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = make(w, h, 255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask[(y + minY) * img.width + x + minX]) {
        const o = (y * w + x) * 4; out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
      }
    }
    return pad(out, 30);
  }

  // ---------- text helpers ----------
  const digitsOnly = (s) =>
    (s || "").replace(/[OoQD]/g, "0").replace(/[IlL|!]/g, "1").replace(/S/g, "5").replace(/\D/g, "");

  function parseHeader(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = { name: "", last: "", first: "", school: "", job: "", subjectOcr: "", subjectLineFound: false, lines };
    for (const l of lines) {
      let m = l.match(/\bSchool\s*:\s*(.+)/);
      if (m && !out.school && !/job/i.test(l)) out.school = m[1].replace(/^[\s|_]+|[\s|_]+$/g, "");
      m = l.match(/Job\s*Name\s*:\s*(.+)/i);
      if (m) out.job = m[1].replace(/^[\s|_]+|[\s|_]+$/g, "");
      // the colon after "Subject ID" (OCR often turns "ID" into "1D" or "I1D")
      m = l.match(/Subject[^:;]{0,6}[:;](.*?)(Class|$)/i) || l.match(/Subject\s*[I1l|]*D(.*?)(Class|$)/i);
      if (m) { out.subjectOcr = digitsOnly(m[1]); out.subjectLineFound = true; }
    }
    for (const l of lines) {
      if (/school/i.test(l)) break;
      const m = l.match(/([A-Z][A-Za-z'.\- ]+),\s*([A-Z][A-Za-z'.\- ]+)/);
      if (m) {
        out.last = m[1].trim();
        out.first = m[2].trim().replace(/(\s+([a-z]{1,2}|[^A-Za-z]+))+$/, "").replace(/[\s\-'.]+$/, ""); // drop stray "ti", "ia", "-"
        out.name = `${out.last}, ${out.first}`;
        break;
      }
    }
    return out;
  }

  // ---------- reading a slate ----------
  /**
   * engine.ocr(img, { psm, whitelist }) -> Promise<{ text, words: [{ text, bbox:{x0,y0,x1,y1} }] }>
   * engine.barcodes(img) -> Promise<string[]>   (Code 39 only)
   */
  async function readSlate(page, engine) {
    const r = { barcode: "", barcodeNote: "", header: null, reads: [], code: "", isSlate: true };

    // 1. barcode in the studio box, retrying with contrast cleanup for dense 10-digit codes
    const box = crop(page, 0.5, 0, 1, 0.3);
    const attempts = [() => box, () => threshold(box, 100), () => threshold(box, 80), () => threshold(box, 120),
      () => threshold(box, 60), () => threshold(box, 140)];
    for (const make of attempts) {
      const vals = [...new Set((await engine.barcodes(make())).map((v) => v.trim()).filter(Boolean))];
      if (vals.length === 1) { r.barcode = vals[0]; break; }
      if (vals.length > 1) { r.barcodeNote = "more than one barcode: " + vals.join(", "); break; }
    }

    // 2. header block
    const head = gray(crop(page, 0, 0, 0.56, 0.24));
    const h = await engine.ocr(head, { psm: "6" });
    r.header = parseHeader(h.text);
    r.headerImage = head;
    if (!r.barcode && !r.header.subjectLineFound && !r.header.school) {
      r.isSlate = false;
      return r;
    }

    // name: read from the red printed ink only, stopping before the studio box, so its border and label never mix in
    const nameInk = redInk(crop(page, 0.02, 0, 0.52, 0.075));
    if (nameInk) {
      const nm = await engine.ocr(nameInk, { psm: "7" });
      const m = nm.text.replace(/\s+/g, " ").trim().match(/^([A-Za-z][A-Za-z'.\- ]*?)\s*[,.]\s*([A-Za-z][A-Za-z'.\- ]*)$/);
      if (m) {
        r.header.last = m[1].trim();
        r.header.first = m[2].trim().replace(/[\s\-'.]+$/, "");
        r.header.name = `${r.header.last}, ${r.header.first}`;
      }
    }

    // 3. Subject ID: read twice, a third time if they disagree, majority wins
    if (r.header.subjectOcr) r.reads.push(r.header.subjectOcr);
    const line = subjectLine(head, h.words);
    if (line) {
      const second = await readDigits(engine, scale(line, 2));
      if (second) r.reads.push(second);
      if (new Set(r.reads).size > 1) {
        const third = await readDigits(engine, threshold(scale(line, 3), 150));
        if (third) r.reads.push(third);
      }
    }

    // 4. session type (highlighted, circled or checked)
    r.session = await readSession(page, engine);

    // 5. red school code
    const ink = redInk(crop(page, 0.62, 0.185, 0.92, 0.245));
    if (ink) {
      const c = await engine.ocr(ink, { psm: "7", whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
      r.code = c.text.replace(/[^A-Z]/g, "");
    }
    return r;
  }

  // ---------- session type ----------
  const SESSIONS = ["Yearbook", "Essentials", "Popular", "Graduate", "VIP"];
  // folder names, matching the choices offered when a person picks the session by hand
  const SESSION_CODES = { Yearbook: "YBK", Essentials: "ESS", Popular: "POP", Graduate: "GRAD", VIP: "OTHER" };
  const SESSION_CHOICES = ["YBK", "ESS", "POP", "GRAD", "OTHER"];
  // printed word widths relative to "Yearbook", used to blank out the printed words
  const REL = { Yearbook: 1.0, Essentials: 1.04, Popular: 0.83, Graduate: 1.0, VIP: 0.355 };

  /* Two signals per row:
   *  highlight = share of coloured pixels on the word's own line (highlighter of any colour)
   *  pen       = share of ink around the word, with the printed word blanked out (circles, checks, underlines)
   * Highlight decides first; pen is used only when nothing is highlighted. */
  async function readSession(page, engine) {
    const reg = crop(page, 0.305, 0.37, 0.55, 0.54);
    const o = await engine.ocr(gray(reg), { psm: "6" });
    const found = {};
    for (const w of o.words) {
      const t = w.text.trim().toLowerCase().slice(0, 4);
      SESSIONS.forEach((nm, k) => {
        if (t === nm.toLowerCase().slice(0, 4) && !found[nm]) found[nm] = { k, ...w.bbox };
      });
    }
    const f = Object.entries(found);
    if (f.length < 2) return { choice: "", note: "session type area could not be found" };

    // rows are evenly spaced: fit centre-y = a + b * rowIndex
    const pts = f.map(([, v]) => [v.k, (v.y0 + v.y1) / 2]);
    const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
    const median = (arr) => { const q = [...arr].sort((x, y) => x - y); return q[Math.floor(q.length / 2)]; };
    const hh = median(f.map(([, v]) => v.y1 - v.y0));
    const x0 = Math.min(...f.map(([, v]) => v.x0));
    const unit = median(f.filter(([, v]) => v.y1 - v.y0 <= 1.4 * hh).map(([nm, v]) => (v.x1 - v.x0) / REL[nm]));
    const xr = x0 + unit * 1.04 + hh;

    const W = reg.width, H = reg.height, d = reg.data;
    const color = new Uint8Array(W * H), ink = new Uint8Array(W * H);
    const colDark = new Float64Array(W), rowDark = new Float64Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const c = mx - mn > 28 && mx > 90, dark = mn < 150;
      color[y * W + x] = c; ink[y * W + x] = dark || c;
      if (dark) { colDark[x]++; rowDark[y]++; }
    }
    // drop ruled lines of the form
    for (let x = 0; x < W; x++) if (colDark[x] / H > 0.35) for (let y = 0; y < H; y++) ink[y * W + x] = 0;
    for (let y = 0; y < H; y++) if (rowDark[y] / W > 0.35) ink.fill(0, y * W, (y + 1) * W);
    // blank out the printed words
    SESSIONS.forEach((nm, k) => {
      const cy = a + b * k;
      const yA = Math.max(0, Math.round(cy - 0.7 * hh)), yB = Math.min(H, Math.round(cy + 0.7 * hh));
      const xA = Math.max(0, x0 - 6), xB = Math.min(W, Math.round(x0 + unit * REL[nm] + 6));
      for (let y = yA; y < yB; y++) ink.fill(0, y * W + xA, y * W + xB);
    });
    const share = (m, yA, yB, xA, xB) => {
      yA = Math.max(0, Math.round(yA)); yB = Math.min(H, Math.round(yB));
      xA = Math.max(0, Math.round(xA)); xB = Math.min(W, Math.round(xB));
      let c = 0, t = 0;
      for (let y = yA; y < yB; y++) for (let x = xA; x < xB; x++) { c += m[y * W + x]; t++; }
      return t ? c / t : 0;
    };
    const hl = {}, pen = {};
    SESSIONS.forEach((nm, k) => {
      const cy = a + b * k;
      hl[nm] = share(color, cy - 0.3 * b, cy + 0.3 * b, x0 - 1.5 * hh, xr);
      pen[nm] = share(ink, cy - 0.5 * b, cy + 0.5 * b, x0 - 3 * hh, xr);
    });
    for (const [scores, min, how] of [[hl, 0.12, "highlighted"], [pen, 0.015, "pen mark"]]) {
      const r = Object.entries(scores).sort((x, y) => y[1] - x[1]);
      if (r[0][1] >= min) {
        if (r[0][1] >= 3 * r[1][1]) return { choice: r[0][0], how, scores: { hl, pen } };
        return { choice: "", note: `session type unclear: ${r[0][0]} or ${r[1][0]}`, scores: { hl, pen } };
      }
    }
    return { choice: "", note: "no session type is marked", scores: { hl, pen } };
  }

  // crop of the Subject ID value: right of the word "Subject", left of "Class"
  function subjectLine(head, words) {
    const subj = words.find((w) => /^subject/i.test(w.text));
    if (!subj) return null;
    const hgt = subj.bbox.y1 - subj.bbox.y0;
    let right = head.width;
    for (const w of words) {
      if (/^class/i.test(w.text) && Math.abs(w.bbox.y0 - subj.bbox.y0) < hgt) right = w.bbox.x0;
    }
    const top = Math.max(0, subj.bbox.y0 - Math.floor(hgt / 2));
    const bottom = Math.min(head.height, subj.bbox.y0 + Math.round(hgt * 1.6));
    if (right - subj.bbox.x1 < 10) return null;
    return crop(head, subj.bbox.x1, top, right, bottom);
  }

  async function readDigits(engine, img) {
    const t = await engine.ocr(img, { psm: "7", whitelist: "0123456789:ID" });
    const parts = t.text.split(":");
    return t.text.replace(/\s/g, "") ? parts[parts.length - 1].replace(/\D/g, "") : "";
  }

  // ---------- decision ----------
  function decide(r, knownCodes) {
    const reasons = [], notes = [];
    if (!r.isSlate) return { status: "skipped", reasons: ["not a slate front (no barcode or Subject ID line found)"], notes, subjectId: "" };
    if (r.barcodeNote) reasons.push(r.barcodeNote);
    else if (!r.barcode) reasons.push("barcode could not be read");

    let subjectId = "";
    if (!r.reads.length) {
      reasons.push(r.header.subjectLineFound ? "Subject ID is blank on the slate" : "Subject ID could not be read");
    } else {
      const counts = {};
      r.reads.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
      const top = Math.max(...Object.values(counts));
      const winners = Object.keys(counts).filter((k) => counts[k] === top);
      if (winners.length === 1) {
        subjectId = winners[0];
        if (Object.keys(counts).length > 1) notes.push(`Subject ID read as ${r.reads.join(" / ")}; majority ${subjectId}`);
      } else {
        reasons.push(`Subject ID unclear (read as ${r.reads.join(" / ")})`);
      }
    }
    if (subjectId && r.barcode && subjectId !== r.barcode) {
      reasons.push(`Subject ID ${subjectId} does not match barcode ${r.barcode}`);
    }
    if (!r.code) reasons.push("school code could not be read");
    else if (knownCodes && knownCodes.size && !knownCodes.has(r.code)) reasons.push(`school code ${r.code} is not on the school list`);
    if (!r.header.first && !r.header.last) reasons.push("student name could not be read");
    let session = "", sessionReason = "";
    if (r.session && r.session.choice) {
      session = SESSION_CODES[r.session.choice];
      if (r.session.choice === "VIP") notes.push("VIP is marked; filed under OTHER");
    } else {
      sessionReason = (r.session && r.session.note) || "session type could not be read";
    }

    // anything wrong with the ID, barcode, school or name sends the slate to Flagged;
    // a slate whose only problem is the session type stays with its school and waits for a person to pick it
    if (reasons.length) {
      if (sessionReason) reasons.push(sessionReason);
      return { status: "flagged", reasons, notes, subjectId, session };
    }
    if (sessionReason) return { status: "session", reasons: [sessionReason], notes, subjectId, session };
    return { status: "ok", reasons, notes, subjectId, session };
  }

  function cleanName(s) {
    return (s || "").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "").replace(/\s+/g, " ").trim();
  }

  // "ATM - Jordan Alvarez.pdf"
  function fileBase(r, d, fallback) {
    const code = cleanName(r.code) || "NO CODE";
    const person = cleanName(`${r.header ? r.header.first : ""} ${r.header ? r.header.last : ""}`)
      || `ID ${d.subjectId || r.barcode || fallback}`;
    return `${code} - ${person}`;
  }

  const api = { SESSIONS, SESSION_CODES, SESSION_CHOICES, crop, gray, threshold, scale, pad, redInk, parseHeader, readSlate, decide, fileBase, cleanName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlateCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
