/* Generatore di codici QR minimale (modalità byte, correzione M, versioni 1–10).
   Uso: qrSvg("testo", {size:220}) -> stringa <svg>. Scritto per Casalaggiù, nessuna dipendenza. */
(function (g) {
  // per livello M: [codeword totali, codeword di correzione per blocco, blocchi]
  const T = [null, [26, 10, 1], [44, 16, 1], [70, 26, 1], [100, 18, 2], [134, 24, 2], [172, 16, 4], [196, 18, 4], [242, 22, 4], [292, 22, 5], [346, 26, 5]];
  const AL = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; };
  function divisor(deg) {
    const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
    for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = mul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = mul(root, 2); }
    return r;
  }
  function remainder(data, div) {
    const r = new Array(div.length).fill(0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); }
    return r;
  }
  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const cap = (T[v][0] - T[v][1] * T[v][2]) * 8, cc = v < 10 ? 8 : 16;
      if (4 + cc + bytes.length * 8 <= cap) { ver = v; break; }
    }
    if (!ver) throw new Error("testo troppo lungo per il QR");
    const [tot, ecLen, nb] = T[ver], dataLen = tot - ecLen * nb, cc = ver < 10 ? 8 : 16;
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, cc); bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, dataLen * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0xec; data.length < dataLen; p ^= 0xec ^ 0x11) data.push(p);
    // blocchi e correzione d'errore
    const shortLen = Math.floor(tot / nb) - ecLen, nShort = nb - (tot % nb), div = divisor(ecLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const len = shortLen + (i < nShort ? 0 : 1), d = data.slice(k, k + len); k += len;
      blocks.push({ d, e: remainder(d, div) });
    }
    const out = [];
    for (let i = 0; i <= shortLen; i++) blocks.forEach((b) => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < ecLen; i++) blocks.forEach((b) => out.push(b.e[i]));
    return { ver, cw: out };
  }
  function matrix(ver, cw, mask) {
    const n = 17 + 4 * ver, m = [], fn = [];
    for (let y = 0; y < n; y++) { m.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
    const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
    for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && x < n && y >= 0 && y < n) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } } };
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
    const al = AL[ver], L = al.length;
    for (let i = 0; i < L; i++) for (let j = 0; j < L; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === L - 1) || (i === L - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const format = () => {
      const data = mask; let rem = data; // livello M = 00
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
      set(8, n - 8, true);
    };
    format();
    if (ver >= 7) {
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = n - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
    }
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - v : v;
        if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
    const M = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][mask];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && M(x, y)) m[y][x] = !m[y][x];
    return m;
  }
  function penalty(m) {
    const n = m.length; let p = 0, dark = 0;
    for (let y = 0; y < n; y++) for (let k = 0; k < 2; k++) {
      let run = 1;
      for (let x = 1; x < n; x++) {
        const a = k ? m[x][y] : m[y][x], b = k ? m[x - 1][y] : m[y][x - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
    return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  }
  g.qrMatrix = function (text) {
    const { ver, cw } = encode(text); let best = null, bp = Infinity;
    for (let k = 0; k < 8; k++) { const m = matrix(ver, cw, k), p = penalty(m); if (p < bp) { bp = p; best = m; } }
    return best;
  };
  g.qrSvg = function (text, o = {}) {
    const m = g.qrMatrix(text), n = m.length, q = 4, s = n + q * 2; let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${o.size || 220}" height="${o.size || 220}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  };
  // Codice QR per bonifico SEPA (standard EPC "GiroCode"), leggibile dalle app delle banche
  g.epcText = function (nome, iban, importo, causale) {
    return ["BCD", "002", "1", "SCT", "", String(nome).slice(0, 70), String(iban).replace(/\s+/g, "").toUpperCase(), "EUR" + Number(importo).toFixed(2), "", "", String(causale).slice(0, 140)].join("\n");
  };
})(typeof window !== "undefined" ? window : globalThis);
