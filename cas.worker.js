// cas.worker.js
// Web Worker dedicado para el motor simbólico Giac (giac.wasm) con parser 2D MathPrint (LaTeX <-> Giac) y catálogo TI-Nspire CX CAS

let caseval = null;
let isReady = false;
let lastAns = '0';
let lastAnsLatex = '0';
let currentAngleMode = 'RAD';
const userVariables = new Map();
const WORKER_VERSION = 'v1.27';

self.postMessage({
  type: 'WORKER_INIT',
  workerVersion: WORKER_VERSION
});

self.Module = {
  locateFile: (path) => {
    if (path.endsWith('.wasm')) {
      return './giac.wasm';
    }
    return path;
  },
  print: (text) => {
    console.debug('[Giac stdout]:', text);
  },
  printErr: (text) => {
    console.warn('[Giac stderr]:', text);
  },
  onRuntimeInitialized: () => {
    try {
      const rawCaseval = self.Module.cwrap('caseval', 'string', ['string']);
      caseval = (cmd) => rawCaseval(cmd.replace(/%22/g, '"'));
      bootstrapTIEnvironment();
      isReady = true;
      self.postMessage({
        type: 'READY',
        workerVersion: WORKER_VERSION,
        engine: 'Giac/Xcas WASM (TI-Nspire CAS Mode)',
        variables: getVariablesSnapshot()
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        error: 'No se pudo enlazar caseval en giac.wasm: ' + (err.message || err)
      });
    }
  }
};

try {
  importScripts('./giac.js?v=5');
} catch (err) {
  self.postMessage({
    type: 'ERROR',
    error: 'Error al cargar giac.js en el Web Worker: ' + (err.message || err)
  });
}

function bootstrapTIEnvironment() {
  caseval(`angle_radian:=${currentAngleMode === 'RAD' ? 1 : 0}`);
  caseval('approx_mode:=0');
}

/**
 * Extrae el contenido de un bloque delimitado balanceado (por ejemplo `{...}`, `[...]`, `(...)`)
 * comenzando en `openIdx` (donde `str[openIdx]` es el carácter de apertura).
 */
function extractBalanced(str, openIdx, openChar = '{', closeChar = '}') {
  if (str[openIdx] !== openChar) return null;
  let depth = 1;
  let i = openIdx + 1;
  while (i < str.length && depth > 0) {
    if (str[i] === '\\') {
      i += 2;
      continue;
    }
    if (str[i] === openChar) depth++;
    else if (str[i] === closeChar) depth--;
    i++;
  }
  if (depth !== 0) return null;
  return {
    content: str.slice(openIdx + 1, i - 1),
    endIdx: i
  };
}

/**
 * Salta espacios en blanco desde `idx`
 */
function skipSpaces(str, idx) {
  while (idx < str.length && /\s/.test(str[idx])) idx++;
  return idx;
}

/**
 * Extrae un argumento TeX comenzando en `idx` (saltando espacios iniciales).
 * Soporta tanto bloques con llaves `{...}` como argumentos abreviados de un solo token
 * que MathLive genera sin llaves (p. ej. `\frac99`, `\frac66`, `\frac1{x+1}`, `\sqrt9`, `\frac\pi2`).
 */
function extractTexArg(str, idx) {
  const cur = skipSpaces(str, idx);
  if (cur >= str.length) return null;

  if (str[cur] === '{') {
    return extractBalanced(str, cur, '{', '}');
  }

  if (str[cur] === '\\') {
    let cmdEnd = cur + 1;
    if (cmdEnd < str.length && /[a-zA-Z]/.test(str[cmdEnd])) {
      while (cmdEnd < str.length && /[a-zA-Z]/.test(str[cmdEnd])) cmdEnd++;
    } else if (cmdEnd < str.length) {
      cmdEnd++;
    }
    const cmdName = str.slice(cur, cmdEnd);
    if (cmdName === '\\frac' || cmdName === '\\dfrac' || cmdName === '\\tfrac' || cmdName === '\\cfrac') {
      const arg1 = extractTexArg(str, cmdEnd);
      if (!arg1) return { content: cmdName, endIdx: cmdEnd };
      const arg2 = extractTexArg(str, arg1.endIdx);
      if (!arg2) return { content: str.slice(cur, arg1.endIdx), endIdx: arg1.endIdx };
      return { content: str.slice(cur, arg2.endIdx), endIdx: arg2.endIdx };
    }
    if (cmdName === '\\sqrt') {
      let nextPos = skipSpaces(str, cmdEnd);
      if (str[nextPos] === '[') {
        const opt = extractBalanced(str, nextPos, '[', ']');
        if (opt) nextPos = opt.endIdx;
      }
      const rad = extractTexArg(str, nextPos);
      if (rad) return { content: str.slice(cur, rad.endIdx), endIdx: rad.endIdx };
    }
    return { content: cmdName, endIdx: cmdEnd };
  }

  return {
    content: str[cur],
    endIdx: cur + 1
  };
}

/**
 * Convierte integrales con límites apilados (plantilla con límite inferior primero)
 * \overset{b}{\underset{a}{\int}} o \underset{a}{\overset{b}{\int}}  ->  \int_{a}^{b}
 */
function normalizeStackedIntegrals(str) {
  let s = str;
  for (const [outerCmd, innerCmd] of [['\\overset', '\\underset'], ['\\underset', '\\overset']]) {
    let searchFrom = 0;
    while (true) {
      const idx = s.indexOf(outerCmd, searchFrom);
      if (idx === -1) break;
      const outerArg = extractTexArg(s, idx + outerCmd.length);
      const outerBody = outerArg ? extractTexArg(s, outerArg.endIdx) : null;
      let replaced = false;
      if (outerArg && outerBody) {
        const body = outerBody.content.trim();
        if (body.startsWith(innerCmd)) {
          const innerArg = extractTexArg(body, innerCmd.length);
          const innerBody = innerArg ? extractTexArg(body, innerArg.endIdx) : null;
          if (
            innerArg &&
            innerBody &&
            innerBody.endIdx === body.length &&
            /^\\int(?:\\limits)?\s*$/.test(innerBody.content.trim())
          ) {
            const upper = outerCmd === '\\overset' ? outerArg.content : innerArg.content;
            const lower = outerCmd === '\\overset' ? innerArg.content : outerArg.content;
            const rebuilt = `\\int_{${lower}}^{${upper}}`;
            s = s.slice(0, idx) + rebuilt + s.slice(outerBody.endIdx);
            searchFrom = idx + rebuilt.length;
            replaced = true;
          }
        }
      }
      if (!replaced) searchFrom = idx + outerCmd.length;
    }
  }
  return s;
}

/**
 * Convierte LaTeX 2D interactivo (procedente de MathLive <math-field>) a sintaxis algebraica Giac/TI-Nspire.
 * Soporta fracciones anidadas, integrales definidas/indefinidas, derivadas de orden n, raíces n-ésimas,
 * sumatorias, productorias, límites, logaritmos en base b y matrices 2D.
 */
function latexToGiac(rawLatex) {
  if (!rawLatex) return '';
  let s = rawLatex.trim();

  // Permitir omitir el segundo argumento opcional (p. ej. en solve(ecuación, □) o sistemas matriciales)
  s = s.replace(/,\s*\\placeholder(?:\[[^\]]*\])?\{\s*\}/g, '');

  // Detectar si quedaron cajas de plantilla vacías (\placeholder{})
  if (/\\placeholder(?:\[[^\]]*\])?\{\s*\}/.test(s)) {
    throw new Error('Completa todos los recuadros vacíos (□) de la plantilla.');
  }

  // desenvolver \placeholder{contenido}
  while (s.includes('\\placeholder')) {
    const idx = s.indexOf('\\placeholder');
    let cur = idx + '\\placeholder'.length;
    cur = skipSpaces(s, cur);
    if (s[cur] === '[') {
      const opt = extractBalanced(s, cur, '[', ']');
      if (opt) cur = opt.endIdx;
    }
    cur = skipSpaces(s, cur);
    if (s[cur] === '{') {
      const br = extractBalanced(s, cur, '{', '}');
      if (br) {
        s = s.slice(0, idx) + br.content + s.slice(br.endIdx);
        continue;
      }
    }
    break;
  }

  // Integrales con límites apilados (\overset / \underset) -> \int_{a}^{b}
  s = normalizeStackedIntegrals(s);

  // Limpiar comandos de estilo de MathLive (\mathrm, \text, \operatorname, \left, \right, \, \: \; \!)
  const unwrapCommands = ['\\mathrm', '\\text', '\\operatorname', '\\mathbf', '\\mathit'];
  for (const cmd of unwrapCommands) {
    while (s.includes(cmd)) {
      const idx = s.indexOf(cmd);
      const cur = skipSpaces(s, idx + cmd.length);
      if (s[cur] === '{') {
        const br = extractBalanced(s, cur, '{', '}');
        if (br) {
          s = s.slice(0, idx) + br.content + s.slice(br.endIdx);
          continue;
        }
      }
      s = s.slice(0, idx) + s.slice(idx + cmd.length);
    }
  }

  // Matrices 2D: \begin{bmatrix} a & b \\ c & d \end{bmatrix} y \left[\begin{array}{ccc} ... \end{array}\right]
  const convertMatrixBody = (_, body) => {
    const rows = body
      .split(/\\\\/)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((rowStr) => {
        const cols = rowStr.split('&').map((c) => latexToGiac(c.trim()));
        return `[${cols.join(', ')}]`;
      });
    return `([${rows.join(', ')}])`;
  };
  s = s.replace(/\\begin\{(?:b|p|v|B|V)?matrix\}([\s\S]*?)\\end\{(?:b|p|v|B|V)?matrix\}/g, convertMatrixBody);
  s = s.replace(
    /(?:\\left\s*(?:\\?[\[(|]))?\s*\\begin\{array\}(?:\{[^}]*\})?([\s\S]*?)\\end\{array\}\s*(?:\\right\s*(?:\\?[\])|.]))?/g,
    convertMatrixBody
  );

  // Valor absoluto \left| ... \right|
  while (s.includes('\\left|')) {
    const start = s.indexOf('\\left|');
    const end = s.indexOf('\\right|', start + 6);
    if (end !== -1) {
      const inner = latexToGiac(s.slice(start + 6, end));
      s = s.slice(0, start) + `abs(${inner})` + s.slice(end + 7);
    } else {
      break;
    }
  }

  s = s
    .replace(/\\(?:d|t|c)frac\b/g, '\\frac')
    .replace(/\\left\s*\(/g, '(')
    .replace(/\\right\s*\)/g, ')')
    .replace(/\\left\s*\[/g, '[')
    .replace(/\\right\s*\]/g, ']')
    .replace(/\\left\s*\\\{/g, '[')
    .replace(/\\right\s*\\\}/g, ']')
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ');

  // Multiplicación implícita antes de funciones matemáticas y constantes (ej. x\sin(x) -> x*\sin(x), 2\pi -> 2*\pi)
  // Se ignora si el prefijo es un comando TeX (como \int, \sum, \lim)
  const fnTokenList = 'sin|cos|tan|csc|sec|cot|arcsin|arccos|arctan|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|sqrt|pi|exponentialE|imaginaryI';
  const implicitFnRegex = new RegExp('(\\\\?[a-zA-Z0-9_]+|\\))\\s*(\\\\(' + fnTokenList + ')\\b)', 'g');
  s = s.replace(implicitFnRegex, (match, prefix, fnCmd) => {
    if (prefix.startsWith('\\')) return match;
    return prefix + '*' + fnCmd;
  });

  // Funciones trigonométricas inversas antes de procesar exponentes
  s = s
    .replace(/\\sin\s*\^\s*\{-1\}/g, 'asin')
    .replace(/\\cos\s*\^\s*\{-1\}/g, 'acos')
    .replace(/\\tan\s*\^\s*\{-1\}/g, 'atan')
    .replace(/\\csc\s*\^\s*\{-1\}/g, 'acsc')
    .replace(/\\sec\s*\^\s*\{-1\}/g, 'asec')
    .replace(/\\cot\s*\^\s*\{-1\}/g, 'acot')
    .replace(/\\arcsin/g, 'asin')
    .replace(/\\arccos/g, 'acos')
    .replace(/\\arctan/g, 'atan')
    .replace(/\\sin/g, 'sin')
    .replace(/\\cos/g, 'cos')
    .replace(/\\tan/g, 'tan')
    .replace(/\\csc/g, 'csc')
    .replace(/\\sec/g, 'sec')
    .replace(/\\cot/g, 'cot')
    .replace(/\\ln/g, 'ln');

  // Logaritmo con base: \log_{b}(x) o \log_{b} x
  while (s.includes('\\log')) {
    const idx = s.indexOf('\\log');
    let cur = skipSpaces(s, idx + 4);
    let baseStr = '10';
    if (s[cur] === '_') {
      const b = extractTexArg(s, cur + 1);
      if (b) {
        baseStr = latexToGiac(b.content);
        cur = b.endIdx;
      }
    }
    cur = skipSpaces(s, cur);
    let argStr = '';
    if (s[cur] === '(') {
      const a = extractBalanced(s, cur, '(', ')');
      if (a) {
        argStr = latexToGiac(a.content);
        cur = a.endIdx;
      }
    } else {
      const a = extractTexArg(s, cur);
      if (a) {
        argStr = latexToGiac(a.content);
        cur = a.endIdx;
      }
    }
    s = s.slice(0, idx) + `log(${argStr}, ${baseStr})` + s.slice(cur);
  }

  // Sumatoria \sum_{k=a}^{b}(expr) y Productoria \prod_{k=a}^{b}(expr)
  for (const [texCmd, giacFn] of [['\\sum', 'sum'], ['\\prod', 'product']]) {
    while (s.includes(texCmd)) {
      const idx = s.indexOf(texCmd);
      let cur = skipSpaces(s, idx + texCmd.length);
      let lowPart = '';
      let upPart = '';
      for (let k = 0; k < 2; k++) {
        cur = skipSpaces(s, cur);
        if (s[cur] === '_') {
          const b = extractTexArg(s, cur + 1);
          if (b) { lowPart = b.content; cur = b.endIdx; }
        } else if (s[cur] === '^') {
          const b = extractTexArg(s, cur + 1);
          if (b) { upPart = b.content; cur = b.endIdx; }
        }
      }
      cur = skipSpaces(s, cur);
      let bodyStr = '';
      if (s[cur] === '(') {
        const a = extractBalanced(s, cur, '(', ')');
        if (a) { bodyStr = a.content; cur = a.endIdx; }
      } else if (s[cur] === '{') {
        const a = extractBalanced(s, cur, '{', '}');
        if (a) { bodyStr = a.content; cur = a.endIdx; }
      } else {
        bodyStr = s.slice(cur);
        cur = s.length;
      }
      const eqSplit = lowPart.split('=');
      const vName = latexToGiac(eqSplit[0] || 'k');
      const vLow = latexToGiac(eqSplit[1] || '1');
      const vUp = latexToGiac(upPart || 'n');
      const vBody = latexToGiac(bodyStr);
      s = s.slice(0, idx) + `${giacFn}(${vBody}, ${vName}, ${vLow}, ${vUp})` + s.slice(cur);
    }
  }

  // Límite \lim_{x \to a}(expr)
  while (s.includes('\\lim')) {
    const idx = s.indexOf('\\lim');
    let cur = skipSpaces(s, idx + 4);
    let subContent = '';
    if (s[cur] === '_') {
      const b = extractTexArg(s, cur + 1);
      if (b) { subContent = b.content; cur = b.endIdx; }
    }
    cur = skipSpaces(s, cur);
    let bodyStr = '';
    if (s[cur] === '(') {
      const a = extractBalanced(s, cur, '(', ')');
      if (a) { bodyStr = a.content; cur = a.endIdx; }
    } else if (s[cur] === '{') {
      const a = extractBalanced(s, cur, '{', '}');
      if (a) { bodyStr = a.content; cur = a.endIdx; }
    } else {
      bodyStr = s.slice(cur);
      cur = s.length;
    }
    const toSplit = subContent.split(/\\to|\\rightarrow|->/);
    const vName = latexToGiac(toSplit[0] || 'x');
    const vPt = latexToGiac(toSplit[1] || '0');
    const vBody = latexToGiac(bodyStr);
    s = s.slice(0, idx) + `limit(${vBody}, ${vName}, ${vPt})` + s.slice(cur);
  }

  // Integrales definidas e indefinidas: \int_{a}^{b} expr dvar o \int expr dvar
  while (s.includes('\\int')) {
    const idx = s.indexOf('\\int');
    let cur = skipSpaces(s, idx + 4);
    let lowStr = null;
    let upStr = null;
    for (let k = 0; k < 2; k++) {
      cur = skipSpaces(s, cur);
      if (s[cur] === '_') {
        const b = extractTexArg(s, cur + 1);
        if (b) { lowStr = latexToGiac(b.content); cur = b.endIdx; }
      } else if (s[cur] === '^') {
        const b = extractTexArg(s, cur + 1);
        if (b) { upStr = latexToGiac(b.content); cur = b.endIdx; }
      }
    }
    const rest = s.slice(cur);
    const dMatch = rest.match(/(?:\\differentialD|\bd)\s*\(?([a-zA-Z_][a-zA-Z0-9_]*)\)?/);
    if (dMatch) {
      // Quitar un operador de multiplicación colgante antes del diferencial (p. ej. "sin(x)·cos(x)·dx")
      const integrandRaw = rest
        .slice(0, dMatch.index)
        .replace(/(?:\\cdot|\\times|\*|\s)+$/, '')
        .trim();
      const varName = dMatch[1];
      const afterIdx = cur + dMatch.index + dMatch[0].length;
      const integrand = latexToGiac(integrandRaw || '1');
      const giacInt =
        lowStr !== null && upStr !== null
          ? `integrate(${integrand}, ${varName}, ${lowStr}, ${upStr})`
          : `integrate(${integrand}, ${varName})`;
      s = s.slice(0, idx) + giacInt + s.slice(afterIdx);
    } else {
      break;
    }
  }

  // Fracciones y Derivadas: \frac{num}{den} o \frac99 (sin llaves en tokens individuales)
  while (s.includes('\\frac')) {
    const idx = s.indexOf('\\frac');
    const numBlock = extractTexArg(s, idx + 5);
    if (!numBlock) break;
    const denBlock = extractTexArg(s, numBlock.endIdx);
    if (!denBlock) break;

    const numRaw = numBlock.content.trim();
    const denRaw = denBlock.content.trim();
    const afterFrac = skipSpaces(s, denBlock.endIdx);

    // Comprobar si es plantilla de derivada: \frac{d}{dx}(expr) o \frac{d^{n}}{dx^{n}}(expr)
    const derivNumMatch = numRaw.match(/^(?:\\differentialD|d)(?:\^\s*\{?(\d+|\w+)\}?)?$/);
    const derivDenMatch = denRaw.match(/^(?:\\differentialD|d)\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\^\s*\{?(\d+|\w+)\}?)?$/);

    if (derivNumMatch && derivDenMatch) {
      const order = derivNumMatch[1] || derivDenMatch[2] || '1';
      const vName = derivDenMatch[1];
      let targetExpr = '';
      let endTarget = afterFrac;
      if (s[afterFrac] === '(') {
        const argBlock = extractBalanced(s, afterFrac, '(', ')');
        if (argBlock) {
          targetExpr = latexToGiac(argBlock.content);
          endTarget = argBlock.endIdx;
        }
      } else if (s[afterFrac] === '{') {
        const argBlock = extractBalanced(s, afterFrac, '{', '}');
        if (argBlock) {
          targetExpr = latexToGiac(argBlock.content);
          endTarget = argBlock.endIdx;
        }
      } else {
        targetExpr = latexToGiac(s.slice(afterFrac));
        endTarget = s.length;
      }
      const diffCall = order === '1' ? `diff(${targetExpr}, ${vName})` : `diff(${targetExpr}, ${vName}, ${order})`;
      s = s.slice(0, idx) + diffCall + s.slice(endTarget);
    } else {
      const numGiac = latexToGiac(numRaw);
      const denGiac = latexToGiac(denRaw);
      s = s.slice(0, idx) + `((${numGiac})/(${denGiac}))` + s.slice(denBlock.endIdx);
    }
  }

  // Raíces cuadradas y n-ésimas: \sqrt[n]{x}, \sqrt{x} o \sqrt9
  while (s.includes('\\sqrt')) {
    const idx = s.indexOf('\\sqrt');
    let cur = skipSpaces(s, idx + 5);
    let rootIndex = null;
    if (s[cur] === '[') {
      const opt = extractBalanced(s, cur, '[', ']');
      if (opt) {
        rootIndex = latexToGiac(opt.content);
        cur = skipSpaces(s, opt.endIdx);
      }
    }
    const radBlock = extractTexArg(s, cur);
    if (!radBlock) break;
    const radGiac = latexToGiac(radBlock.content);
    const replacement = rootIndex ? `((${radGiac})^(1/(${rootIndex})))` : `sqrt(${radGiac})`;
    s = s.slice(0, idx) + replacement + s.slice(radBlock.endIdx);
  }

  // Exponentes con llaves o comandos: ^{...} o ^\pi -> ^(...)
  while (s.includes('^')) {
    const idx = s.indexOf('^');
    const cur = skipSpaces(s, idx + 1);
    if (s[cur] === '{' || s[cur] === '\\') {
      const expBlock = extractTexArg(s, cur);
      if (expBlock) {
        const innerExp = latexToGiac(expBlock.content);
        s = s.slice(0, idx) + `__POW__(${innerExp})` + s.slice(expBlock.endIdx);
        continue;
      }
    }
    s = s.slice(0, idx) + '__POW__' + s.slice(idx + 1);
  }
  s = s.replace(/__POW__/g, '^');

  // Subíndices _{...} -> _...
  while (s.includes('_')) {
    const idx = s.indexOf('_');
    const cur = skipSpaces(s, idx + 1);
    if (s[cur] === '{') {
      const subBlock = extractBalanced(s, cur, '{', '}');
      if (subBlock) {
        s = s.slice(0, idx) + '__SUB__' + latexToGiac(subBlock.content) + s.slice(subBlock.endIdx);
        continue;
      }
    }
    s = s.slice(0, idx) + '__SUB__' + s.slice(idx + 1);
  }
  s = s.replace(/__SUB__/g, '_');

  // Bloques residuales entre llaves {a} -> (a)
  while (s.includes('{')) {
    const idx = s.indexOf('{');
    const b = extractBalanced(s, idx, '{', '}');
    if (!b) break;
    s = s.slice(0, idx) + `(${latexToGiac(b.content)})` + s.slice(b.endIdx);
  }

  // Símbolos constantes, operadores relacionales y letras griegas en LaTeX
  s = s
    .replace(/\\exponentialE\b/g, 'e')
    .replace(/\\imaginaryI\b/g, 'i')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\+\s*\\infty\b/g, '+infinity')
    .replace(/-\s*\\infty\b/g, '-infinity')
    .replace(/\\infty\b/g, '+infinity')
    .replace(/\\alpha\b/g, 'alpha')
    .replace(/\\beta\b/g, 'beta')
    .replace(/\\gamma\b/g, 'gamma')
    .replace(/\\delta\b/g, 'delta')
    .replace(/\\epsilon\b/g, 'epsilon')
    .replace(/\\theta\b/g, 'theta')
    .replace(/\\lambda\b/g, 'lambda')
    .replace(/\\mu\b/g, 'mu')
    .replace(/\\rho\b/g, 'rho')
    .replace(/\\sigma\b/g, 'sigma')
    .replace(/\\tau\b/g, 'tau')
    .replace(/\\phi\b/g, 'phi')
    .replace(/\\omega\b/g, 'omega')
    .replace(/\\Delta\b/g, 'Delta')
    .replace(/\\Sigma\b/g, 'Sigma')
    .replace(/\\Omega\b/g, 'Omega')
    .replace(/\\cdot/g, '*')
    .replace(/\\mid\b|\\vert\b/g, '|')
    .replace(/\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\neq/g, '!=')
    .replace(/\\le(?:q)?\b/g, '<=')
    .replace(/\\ge(?:q)?\b/g, '>=')
    .replace(/\\to\b|\\rightarrow\b/g, '->')
    .replace(/\\triangleq\b|\\coloneqq\b/g, ':=');

  // Multiplicación implícita entre matrices y vectores/escalares:
  // Soporta tanto matrices con paréntesis ([[...]])([[...]]) como con corchetes directos [[...]][[...]]
  s = s
    .replace(/\]\)\s*\(\[/g, '])*([')
    .replace(/\]\]\s*\[\[/g, ']]*[[')
    .replace(/\]\)\s*\[\[/g, '])*[[')
    .replace(/\]\]\s*\(\[/g, ']]*([')
    .replace(/\]\)\s*([a-zA-Z0-9_(])/g, '])*$1')
    .replace(/\]\]\s*([a-zA-Z0-9_(])/g, ']]*$1')
    .replace(/(?<![a-zA-Z_])([0-9])\s*\(\[/g, '$1*([')
    .replace(/(?<![a-zA-Z_])([0-9])\s*\[\[/g, '$1*[[')
    .replace(/(?<![a-zA-Z0-9_])([a-zA-Z])\s*\(\[\[/g, '$1*([[')
    .replace(/(?<![a-zA-Z0-9_])([a-zA-Z])\s*\[\[/g, '$1*[[');

  // Multiplicación implícita tras un paréntesis de cierre: sin(x)cos(x) -> sin(x)*cos(x), (a+b)(c) -> (a+b)*(c), (x)2 -> (x)*2
  s = s.replace(/\)\s*(?=[a-zA-Z0-9_(])/g, ')*');

  return s.trim();
}

function splitTopLevelArgs(argsStr, separator = ',') {
  const args = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === separator && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

function replaceFunctionCalls(expr, fnName, replacer) {
  const regex = new RegExp(`\\b${fnName}\\s*\\(`, 'gi');
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(expr)) !== null) {
    result += expr.slice(lastIndex, match.index);
    const openParenIdx = regex.lastIndex - 1;
    let depth = 1;
    let i = openParenIdx + 1;
    while (i < expr.length && depth > 0) {
      if (expr[i] === '(') depth++;
      else if (expr[i] === ')') depth--;
      i++;
    }
    if (depth === 0) {
      const innerRaw = expr.slice(openParenIdx + 1, i - 1);
      const innerTranspiled = expandTIFunctions(innerRaw);
      const args = splitTopLevelArgs(innerTranspiled);
      result += replacer(args);
      lastIndex = i;
      regex.lastIndex = i;
    } else {
      result += match[0];
      lastIndex = regex.lastIndex;
    }
  }
  result += expr.slice(lastIndex);
  return result;
}

function normalizeEquationArg(exprStr) {
  const parts = splitTopLevelArgs(exprStr, '=');
  if (parts.length === 2) {
    return `((${parts[0]}) - (${parts[1]}))`;
  }
  return exprStr;
}

/**
 * Elimina envolturas externas redundantes como `(...)`, `list[...]` o `set[...]`
 */
function stripOuterParensAndList(str) {
  let s = (str || '').trim();
  while (s.length > 0) {
    if (s.startsWith('list[') && s.endsWith(']')) {
      s = s.slice(4).trim();
      continue;
    }
    if (s.startsWith('set[') && s.endsWith(']')) {
      s = s.slice(3).trim();
      continue;
    }
    if (s[0] === '(' && s[s.length - 1] === ')') {
      const b = extractBalanced(s, 0, '(', ')');
      if (b && b.endIdx === s.length) {
        s = b.content.trim();
        continue;
      }
    }
    break;
  }
  return s;
}

/**
 * Desenrolla recursivamente en JavaScript cualquier lista o matriz anidada `[[a], [b], [c]]`
 * devolviendo un arreglo plano de expresiones escalares `['a', 'b', 'c']`.
 */
function extractScalarItems(rawStr) {
  const s = stripOuterParensAndList(rawStr);
  if (!s) return [];
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const b = extractBalanced(s, 0, '[', ']');
    if (b && b.endIdx === s.length) {
      const inner = b.content.trim();
      if (!inner) return [];
      const parts = splitTopLevelArgs(inner, ',');
      const result = [];
      for (const part of parts) {
        result.push(...extractScalarItems(part));
      }
      return result;
    }
  }
  return [s];
}

/**
 * Traduce llamadas a solve / cSolve / nSolve soportando tanto ecuaciones escalares como
 * sistemas de ecuaciones matriciales:
 *  - A * X = B (con vector de incógnitas X = [[x], [y], [z]] o [x, y, z])
 *  - A * x = B (con variable simbólica única x representando el vector incógnita)
 *  - Matriz/vector de ecuaciones [[eq1], [eq2]]
 *  - solve(A, B) o solve(A = B) con matriz de coeficientes A y vector independiente B
 *  - solve(M) con matriz aumentada M de dimensión n × (n+1)
 */
function buildSolveGiacExpr(solverFn, args) {
  if (!args || args.length === 0) return `${solverFn}()`;

  const eqArgs = [args[0]];
  const varArgs = [];
  for (let i = 1; i < args.length; i++) {
    if (splitTopLevelArgs(args[i], '=').length === 2) {
      eqArgs.push(args[i]);
    } else {
      varArgs.push(args[i]);
    }
  }

  if (caseval) {
    try {
      const evalClean = (cmd) => caseval(cmd).replace(/;$/, '').trim();
      const isValidGiacOut = (out) =>
        Boolean(
          out &&
            out !== 'undef' &&
            !out.startsWith('GIAC_ERROR') &&
            !out.toLowerCase().startsWith('error') &&
            !out.includes('syntax error')
        );

      // Caso 1: solve(A * x = B, x) donde A es matriz (ncols > 1), B es vector/matriz y x es un identificador simple
      if (eqArgs.length === 1 && varArgs.length === 1 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varArgs[0].trim())) {
        const eqParts = splitTopLevelArgs(eqArgs[0], '=');
        if (eqParts.length === 2) {
          const [lhs, rhs] = eqParts;
          const v = varArgs[0].trim();
          const isRhsMat = evalClean(`ckmatrix(${rhs})`) === '1';
          const isRhsList = evalClean(`type(${rhs})`) === 'DOM_LIST';
          if (isRhsMat || isRhsList) {
            const matA = evalClean(`subst(${lhs}, ${v}=1)`);
            if (evalClean(`ckmatrix(${matA})`) === '1' && Number(evalClean(`ncols(${matA})`)) > 1) {
              const rhsCol = isRhsMat ? rhs : `tran([${rhs}])`;
              return `simult(${matA}, ${rhsCol})`;
            }
          }
        }
      }

      // Caso 2: solve(A, B) o solve(A = B, ...) donde A y B son matrices numéricas sin variables simbólicas (AX = B)
      let candA = null;
      let candB = null;
      if (eqArgs.length === 1 && splitTopLevelArgs(eqArgs[0], '=').length === 2) {
        [candA, candB] = splitTopLevelArgs(eqArgs[0], '=');
      } else if (eqArgs.length === 1 && varArgs.length === 1) {
        [candA, candB] = [eqArgs[0], varArgs[0]];
      }
      if (candA && candB) {
        const isAMat = evalClean(`ckmatrix(${candA})`) === '1';
        const noVarsInAB = evalClean(`lname([${candA}, ${candB}])`) === '[]';
        if (isAMat && noVarsInAB) {
          const isBMat = evalClean(`ckmatrix(${candB})`) === '1';
          const isBList = evalClean(`type(${candB})`) === 'DOM_LIST';
          if (isBMat) {
            const rowsA = Number(evalClean(`nrows(${candA})`));
            const rowsB = Number(evalClean(`nrows(${candB})`));
            const rhsCol = rowsB === 1 && rowsA > 1 ? `tran(${candB})` : candB;
            return `simult(${candA}, ${rhsCol})`;
          } else if (isBList) {
            return `simult(${candA}, tran([${candB}]))`;
          }
        }
      }

      // Caso 3: solve(M) donde M es una matriz aumentada numérica n × (n+1)
      if (eqArgs.length === 1 && splitTopLevelArgs(eqArgs[0], '=').length === 1) {
        const M = eqArgs[0];
        if (evalClean(`ckmatrix(${M})`) === '1' && evalClean(`lname(${M})`) === '[]') {
          const r = Number(evalClean(`nrows(${M})`));
          const c = Number(evalClean(`ncols(${M})`));
          if (r >= 1 && c === r + 1) {
            return `simult(subMat(${M}, 0, 0, ${r - 1}, ${r - 1}), subMat(${M}, 0, ${r}, ${r - 1}, ${r}))`;
          }
        }
      }

      // Caso 4: Sistemas simbólicos de ecuaciones (matriciales A*X = B, vectores de ecuaciones [[eq1],[eq2]] o escalares)
      const eqList = [];
      for (const eqArg of eqArgs) {
        const topEqParts = splitTopLevelArgs(eqArg, '=');
        if (topEqParts.length === 2) {
          const diffExpr = `((${topEqParts[0]}) - (${topEqParts[1]}))`;
          const evalDiff = evalClean(diffExpr);
          if (isValidGiacOut(evalDiff)) {
            const items = extractScalarItems(evalDiff);
            if (items.length > 1) {
              eqList.push(...items);
            } else {
              eqList.push(diffExpr);
            }
          } else {
            eqList.push(diffExpr);
          }
        } else {
          const rawItems = extractScalarItems(eqArg);
          if (rawItems.length > 1) {
            for (const item of rawItems) {
              eqList.push(normalizeEquationArg(item));
            }
          } else {
            const normSingle = normalizeEquationArg(rawItems[0] || eqArg);
            const evalSingle = evalClean(normSingle);
            if (isValidGiacOut(evalSingle)) {
              const items = extractScalarItems(evalSingle);
              if (items.length > 1) {
                eqList.push(...items);
              } else {
                eqList.push(normSingle);
              }
            } else {
              eqList.push(normSingle);
            }
          }
        }
      }

      if (eqList.length > 0) {
        const userVarList = [];
        for (const vArg of varArgs) {
          userVarList.push(...extractScalarItems(vArg));
        }

        const allVarsRaw = evalClean(`lname([${eqList.join(', ')}])`);
        const allVarList = isValidGiacOut(allVarsRaw) ? extractScalarItems(allVarsRaw) : [];

        let targetVarList;
        if (
          userVarList.length === 0 ||
          (eqList.length > 1 && userVarList.length === 1 && allVarList.length > 1)
        ) {
          targetVarList = allVarList.length > 0 ? allVarList : ['x'];
        } else {
          targetVarList = userVarList;
        }

        if (eqList.length === 1 && targetVarList.length === 1) {
          return `${solverFn}(${eqList[0]}, ${targetVarList[0]})`;
        }

        // Detectar si el usuario ingresó las incógnitas como un vector columna [[x], [y], [z]]
        const isColVectorVar = (() => {
          if (varArgs.length !== 1) return false;
          const s = stripOuterParensAndList(varArgs[0]);
          if (s[0] !== '[' || s[s.length - 1] !== ']') return false;
          const b = extractBalanced(s, 0, '[', ']');
          if (!b || b.endIdx !== s.length) return false;
          const rows = splitTopLevelArgs(b.content, ',');
          return (
            rows.length > 1 &&
            rows.every((r) => {
              const rt = r.trim();
              return (
                rt.startsWith('[') &&
                rt.endsWith(']') &&
                splitTopLevelArgs(rt.slice(1, -1), ',').length === 1
              );
            })
          );
        })();

        const solveCall = `${solverFn}([${eqList.join(', ')}], [${targetVarList.join(', ')}])`;
        if (isColVectorVar) {
          const rawSol = evalClean(solveCall).replace(/^list\[/, '[');
          if (isValidGiacOut(rawSol) && rawSol.startsWith('[') && rawSol.endsWith(']')) {
            const bSol = extractBalanced(rawSol, 0, '[', ']');
            if (bSol && bSol.endIdx === rawSol.length) {
              const solTuples = splitTopLevelArgs(bSol.content, ',');
              if (solTuples.length === 1) {
                const tuple = solTuples[0].trim();
                if (tuple.startsWith('[') && tuple.endsWith(']')) {
                  const vals = splitTopLevelArgs(tuple.slice(1, -1), ',');
                  if (vals.length === targetVarList.length) {
                    return `[${vals.map((v) => `[${v}]`).join(', ')}]`;
                  }
                }
              }
            }
          }
        }

        return solveCall;
      }
    } catch (_) {
      // Fallback al comportamiento estándar si falla la inspección previa
    }
  }

  return `${solverFn}(${args.join(', ')})`;
}

function expandTIFunctions(input) {
  let s = input;

  // 1. Menú Número
  s = replaceFunctionCalls(s, 'surd', (a) => `((${a[0]})^(1/(${a[1]})))`);
  s = replaceFunctionCalls(s, 'approx', (a) => `evalf(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'propFrac', (a) => `partfrac(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'getNum', (a) => `numer(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'getDenom', (a) => `denom(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'iPart', (a) => `trunc(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'fPart', (a) => `frac(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'ceiling', (a) => `ceil(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'mod', (a) => `irem(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'real', (a) => `re(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'imag', (a) => `im(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'angle', (a) => `arg(${a.join(', ')})`);

  // 2. Menú Álgebra (con soporte matricial y sistemas en solve / cSolve / nSolve)
  s = replaceFunctionCalls(s, 'solve', (a) => buildSolveGiacExpr('solve', a));
  s = replaceFunctionCalls(s, 'cSolve', (a) => buildSolveGiacExpr('csolve', a));
  s = replaceFunctionCalls(s, 'nSolve', (a) => buildSolveGiacExpr('fsolve', a));
  s = replaceFunctionCalls(s, 'cFactor', (a) => `cfactor(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'cZeros', (a) => `cZeros(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'completeSquare', (a) => `canonical_form(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'polyRoots', (a) => `proot(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'polyCoeffs', (a) => `symb2poly(${a.join(', ')})`);

  // 3. Menú Cálculo
  s = replaceFunctionCalls(s, 'derivative', (a) => `diff(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'integral', (a) => `integrate(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'deSolve', (a) => `desolve(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'impDiff', (a) => `implicit_diff(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'arcLen', (a) => {
    const [expr, v, low, up] = a;
    return `integrate(sqrt(1 + diff(${expr}, ${v})^2), ${v}, ${low}, ${up})`;
  });
  s = replaceFunctionCalls(s, 'taylor', (a) => {
    const [expr, v, order, pt = '0'] = a;
    return `taylor(${expr}, ${v}=${pt}, ${order})`;
  });

  // 4. Menú Probabilidad y Estadística
  s = replaceFunctionCalls(s, 'nPr', (a) => `perm(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'nCr', (a) => `comb(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'randInt', (a) => `randint(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'stdDev', (a) => `stddev(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'normPdf', (a) => {
    const [x, mu = '0', sigma = '1'] = a;
    return `normald(${mu}, ${sigma}, ${x})`;
  });
  s = replaceFunctionCalls(s, 'normCdf', (a) => {
    const [low, up, mu = '0', sigma = '1'] = a;
    return `evalf(normald_cdf(${mu}, ${sigma}, ${up}) - normald_cdf(${mu}, ${sigma}, ${low}))`;
  });
  s = replaceFunctionCalls(s, 'invNorm', (a) => {
    const [area, mu = '0', sigma = '1'] = a;
    return `evalf(normald_icdf(${mu}, ${sigma}, ${area}))`;
  });
  s = replaceFunctionCalls(s, 'tPdf', (a) => {
    const [x, df] = a;
    return `studentd(${df}, ${x})`;
  });
  s = replaceFunctionCalls(s, 'tCdf', (a) => {
    const [low, up, df] = a;
    return `evalf(studentd_cdf(${df}, ${up}) - studentd_cdf(${df}, ${low}))`;
  });
  s = replaceFunctionCalls(s, 'invT', (a) => {
    const [area, df] = a;
    return `evalf(studentd_icdf(${df}, ${area}))`;
  });
  s = replaceFunctionCalls(s, 'chi2Pdf', (a) => {
    const [x, df] = a;
    return `chisquared(${df}, ${x})`;
  });
  s = replaceFunctionCalls(s, 'chi2Cdf', (a) => {
    const [low, up, df] = a;
    return `evalf(chisquared_cdf(${df}, ${up}) - chisquared_cdf(${df}, ${low}))`;
  });
  s = replaceFunctionCalls(s, 'binomPdf', (a) => {
    const [n, p, x] = a;
    return `binomial(${n}, ${x}, ${p})`;
  });
  s = replaceFunctionCalls(s, 'binomCdf', (a) => {
    if (a.length === 3) {
      const [n, p, up] = a;
      return `evalf(binomial_cdf(${n}, ${p}, ${up}))`;
    }
    const [n, p, low, up] = a;
    const cleanLow = String(low).trim();
    if (!isNaN(cleanLow) && Number(cleanLow) <= 0) {
      return `evalf(binomial_cdf(${n}, ${p}, ${up}))`;
    }
    return `evalf(binomial_cdf(${n}, ${p}, ${up}) - when((${low}) <= 0, 0, binomial_cdf(${n}, ${p}, (${low}) - 1)))`;
  });
  s = replaceFunctionCalls(s, 'poissPdf', (a) => {
    const [lambda, x] = a;
    return `poisson(${lambda}, ${x})`;
  });
  s = replaceFunctionCalls(s, 'poissCdf', (a) => {
    if (a.length === 2) {
      const [lambda, up] = a;
      return `evalf(poisson_cdf(${lambda}, ${up}))`;
    }
    const [lambda, low, up] = a;
    const cleanLow = String(low).trim();
    if (!isNaN(cleanLow) && Number(cleanLow) <= 0) {
      return `evalf(poisson_cdf(${lambda}, ${up}))`;
    }
    return `evalf(poisson_cdf(${lambda}, ${up}) - when((${low}) <= 0, 0, poisson_cdf(${lambda}, (${low}) - 1)))`;
  });

  // 5. Menú Matriz y Vector
  s = replaceFunctionCalls(s, 'newMat', (a) => `matrix(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'identity', (a) => `idn(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'transpose', (a) => `tran(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'eigVl', (a) => `egvl(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'eigVc', (a) => `egv(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'crossP', (a) => `cross(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'dotP', (a) => `dot(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'unitV', (a) => `((${a[0]}) / l2norm(${a[0]}))`);

  s = replaceFunctionCalls(s, 'log', (a) => {
    if (a.length === 2) {
      // Base 10 -> log10 (se evalúa exacto: log(100) = 2); otra base -> simplificar ln(x)/ln(b) (log₂(8) = 3)
      if (a[1].replace(/[()\s]/g, '') === '10') return `log10(${a[0]})`;
      return `simplify(ln(${a[0]})/ln(${a[1]}))`;
    }
    return `log10(${a[0]})`;
  });

  return s;
}

function transpileTISyntax(rawInput) {
  // Primero convertir cualquier plantilla LaTeX 2D a expresión algebraica plana
  let expr = latexToGiac(rawInput).trim().replace(/;+$/, '');

  if (/^ClearAZ$/i.test(expr)) {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    return {
      isDelVar: true,
      targetVars: letters
    };
  }

  const delVarMatch = expr.match(/^DelVar\s+(.+)$/i);
  if (delVarMatch) {
    const vars = delVarMatch[1]
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    return {
      isDelVar: true,
      targetVars: vars
    };
  }

  const defineMatch = expr.match(/^Define\s+([^=:]+?)\s*(?::=|=)\s*(.+)$/i);
  if (defineMatch) {
    expr = `${defineMatch[1].trim()} := (${defineMatch[2].trim()})`;
  }

  const stoMatch = expr.match(/^(.+?)\s*(?:->|→|sto->)\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\([^)]*\))?)$/i);
  if (stoMatch) {
    expr = `${stoMatch[2].trim()} := (${stoMatch[1].trim()})`;
  }

  const pipeParts = splitTopLevelArgs(expr, '|');
  if (pipeParts.length === 2) {
    const baseExpr = pipeParts[0];
    const conds = splitTopLevelArgs(pipeParts[1], ',');
    expr = `subst(${baseExpr}, [${conds.join(',')}])`;
  }

  expr = expr
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/≠/g, '!=')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/π/g, 'pi')
    .replace(/\+\s*∞/g, '+infinity')
    .replace(/-\s*∞/g, '-infinity')
    .replace(/∞/g, '+infinity')
    .replace(/(^|[^a-zA-Z0-9_+-])\+?infinity\b/g, '$1+infinity')
    .replace(/(^|[^a-zA-Z0-9_+-])-infinity\b/g, '$1-infinity')
    .replace(/𝑖/g, 'i')
    .replace(/√\(([^)]+)\)/g, 'sqrt($1)')
    .replace(/(\d+(?:\.\d+)?)\s*ᴇ\s*([+-]?\d+)/g, '($1*10^($2))');

  if (currentAngleMode === 'RAD') {
    expr = expr.replace(/(\d+(?:\.\d+)?|\([^)]+\))\s*°/g, '(($1)*pi/180)');
  } else {
    expr = expr.replace(/°/g, '');
  }

  expr = expr.replace(/\b(?:Ans|ans)\b/g, `(${lastAns})`);
  expr = expandTIFunctions(expr);

  let assignedSymbol = null;
  let isFunctionDef = false;
  const assignMatch = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\s*\([^)]*\))?\s*:=\s*(.+)$/);
  if (assignMatch) {
    const symName = assignMatch[1].trim();
    const symParams = assignMatch[2] ? assignMatch[2].trim() : '';
    if (symName.toLowerCase() === 'ans') {
      throw new Error('Ans es una variable automática de solo lectura.');
    }
    assignedSymbol = symName + symParams;
    isFunctionDef = Boolean(symParams);
  }

  return {
    isDelVar: false,
    assignedSymbol,
    isFunctionDef,
    giacExpr: expr
  };
}

function extractLatexParenGroup(str, startIdx) {
  const cur = skipSpaces(str, startIdx);
  if (str.startsWith('\\left(', cur)) {
    let depth = 1;
    let i = cur + 6;
    while (i < str.length && depth > 0) {
      if (str.startsWith('\\left(', i)) {
        depth++;
        i += 6;
      } else if (str.startsWith('\\right)', i)) {
        depth--;
        i += 7;
      } else {
        i++;
      }
    }
    if (depth === 0) {
      return {
        content: str.slice(cur + 6, i - 7),
        endIdx: i
      };
    }
  }
  if (str[cur] === '(') {
    return extractBalanced(str, cur, '(', ')');
  }
  return null;
}

/**
 * Convierte la notación de Giac `\sin\^{2}x` o `\sin\^{2}\left(u\right)`
 * al formato con paréntesis exteriores `\left(\sin\left(x\right)\right)^{2}`.
 */
function normalizeGiacTrigPowers(latexStr) {
  let s = latexStr;
  const regex = /(\\[a-zA-Z]+)\s*\\\^\s*\{/;
  let safety = 0;
  while (safety++ < 100) {
    const match = regex.exec(s);
    if (!match) break;

    const fnCmd = match[1];
    const openBraceIdx = match.index + match[0].length - 1;
    const expBlock = extractBalanced(s, openBraceIdx, '{', '}');
    if (!expBlock) {
      s = s.slice(0, match.index) + `${fnCmd}^{` + s.slice(openBraceIdx + 1);
      continue;
    }

    const expContent = normalizeGiacTrigPowers(expBlock.content);
    const afterExp = skipSpaces(s, expBlock.endIdx);
    let argContent = '';
    let endArgIdx = afterExp;

    const parenGroup = extractLatexParenGroup(s, afterExp);
    if (parenGroup) {
      argContent = normalizeGiacTrigPowers(parenGroup.content);
      endArgIdx = parenGroup.endIdx;
    } else {
      const tok = extractTexArg(s, afterExp);
      if (tok) {
        let endTok = tok.endIdx;
        while (endTok < s.length && (s[endTok] === '_' || s[endTok] === '^')) {
          const subSup = extractTexArg(s, endTok + 1);
          if (subSup) endTok = subSup.endIdx;
          else break;
        }
        argContent = normalizeGiacTrigPowers(s.slice(afterExp, endTok).trim());
        endArgIdx = endTok;
      }
    }

    const replacement = `\\left(${fnCmd}\\left(${argContent}\\right)\\right)^{${expContent}}`;
    s = s.slice(0, match.index) + replacement + s.slice(endArgIdx);
  }
  s = s.replace(/\\\^\s*\{/g, '^{');
  return s;
}

/**
 * Omite el operador \cdot en la salida en productos inequívocos:
 * - Coeficiente numérico antes de variable o símbolo: 2\cdot x -> 2x, 2\cdot \pi -> 2\pi
 * - Factores con paréntesis: 2\cdot (x+1) -> 2(x+1), x\cdot (x+1) -> x(x+1), (x-1)\cdot (x+1) -> (x-1)(x+1)
 * Se preserva intacto entre dos variables (x\cdot y) y entre dos números (2\cdot 3).
 */
function cleanOutputMultiplicationDots(latexStr) {
  let s = latexStr;
  s = s.replace(/([0-9])\s*\\cdot\s*(?!\\(?:d|t)?frac\b)([a-zA-Z\\](?![0-9]))/g, '$1$2');
  s = s.replace(/([0-9a-zA-Z_])\s*\\cdot\s*(\(|\\left\()/g, '$1$2');
  s = s.replace(/(\)|\\right\))\s*\\cdot\s*(\(|\\left\()/g, '$1$2');
  s = s.replace(/(\)|\\right\))\s*\\cdot\s*(?!\\(?:d|t)?frac\b)([0-9a-zA-Z_]|\\left\(|\()/g, '$1$2');
  return s;
}

function giacExprToLatex(exprStr) {
  if (!exprStr) return '';
  let rawLatex = caseval(`latex(${exprStr})`).replace(/;$/, '').trim();
  if (
    !rawLatex ||
    rawLatex === 'undef' ||
    rawLatex.startsWith('GIAC_ERROR') ||
    rawLatex.toLowerCase().startsWith('error') ||
    rawLatex.includes('syntax error')
  ) {
    rawLatex = caseval(`latex(quote(${exprStr}))`).replace(/;$/, '').trim();
  }
  let s = rawLatex;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\frac\{\(([^()]+)\)\}/g, '\\frac{$1}');
  s = normalizeGiacTrigPowers(s);
  s = cleanOutputMultiplicationDots(s);
  s = s.replace(/\\left\(\\begin\{array\}\{[^}]*\}/g, '\\begin{bmatrix}');
  s = s.replace(/\\end\{array\}\\right\)/g, '\\end{bmatrix}');
  return s.trim();
}

function getVariablesSnapshot() {
  const list = [];
  if (lastAns !== '0') {
    list.push({ name: 'Ans', value: lastAns, latex: lastAnsLatex });
  }
  for (const [name, value] of userVariables.entries()) {
    list.push({ name, value });
  }
  return list;
}

self.onmessage = (event) => {
  const { id, type, expr, inputLatex, forceApprox, angleMode } = event.data;

  if (!isReady || !caseval) {
    self.postMessage({
      id,
      status: 'ERROR',
      inputExpr: expr,
      inputLatex: inputLatex || expr,
      error: 'El motor simbólico giac.wasm aún se está inicializando...'
    });
    return;
  }

  if (type === 'SET_ANGLE_MODE') {
    currentAngleMode = angleMode === 'DEG' ? 'DEG' : 'RAD';
    const isRad = currentAngleMode === 'RAD' ? 1 : 0;
    caseval(`angle_radian:=${isRad}`);
    self.postMessage({ id, status: 'ANGLE_MODE_OK', angleMode: currentAngleMode });
    return;
  }

  if (type === 'RESET_NAMESPACE') {
    caseval('restart');
    userVariables.clear();
    lastAns = '0';
    lastAnsLatex = '0';
    bootstrapTIEnvironment();
    self.postMessage({
      id,
      status: 'RESET_OK',
      variables: getVariablesSnapshot()
    });
    return;
  }

  if (type === 'EVAL') {
    try {
      const { isDelVar, targetVars, assignedSymbol, isFunctionDef, giacExpr } = transpileTISyntax(expr);

      if (isDelVar) {
        for (const v of targetVars) {
          caseval(`purge(${v})`);
          userVariables.delete(v);
          for (const key of userVariables.keys()) {
            if (key.startsWith(v + '(')) userVariables.delete(key);
          }
        }
        self.postMessage({
          id,
          status: 'OK',
          inputExpr: expr,
          inputLatex: inputLatex || expr,
          raw: 'Done',
          approxRaw: 'Done',
          exactLatex: `\\text{Done}`,
          approxLatex: `\\text{Done}`,
          variables: getVariablesSnapshot()
        });
        return;
      }

      if (isFunctionDef) {
        const rawOut = caseval(giacExpr).replace(/;$/, '').trim();
        if (
          rawOut.startsWith('GIAC_ERROR') ||
          rawOut.toLowerCase().startsWith('error') ||
          rawOut.includes('syntax error')
        ) {
          throw new Error(rawOut.replace(/^GIAC_ERROR:\s*/i, ''));
        }
        const rhs = giacExpr.split(':=')[1].trim();
        userVariables.set(assignedSymbol, rhs);
        self.postMessage({
          id,
          status: 'OK',
          inputExpr: expr,
          inputLatex: inputLatex || expr,
          raw: 'Done',
          approxRaw: 'Done',
          exactLatex: `\\text{Done}`,
          approxLatex: `\\text{Done}`,
          variables: getVariablesSnapshot()
        });
        return;
      }

      const SKIP_SIMPLIFY_RE = /^(?:factor|cfactor|partfrac|propfrac|expand|texpand|tcollect|rref|ref|egvl|egv|solve|csolve|nsolve|zeros|czeros|desolve|normald)\s*\(/i;
      let rawGiacOut = caseval(giacExpr).replace(/;$/, '').trim();

      if (
        !rawGiacOut ||
        rawGiacOut === 'undef' ||
        rawGiacOut.startsWith('GIAC_ERROR') ||
        rawGiacOut.toLowerCase().startsWith('error') ||
        rawGiacOut.includes('syntax error')
      ) {
        throw new Error((rawGiacOut || 'Expresión indefinida').replace(/^GIAC_ERROR:\s*/i, ''));
      }

      const cleanInitialOut = rawGiacOut.replace(/^list\[/, '[');
      if (forceApprox) {
        const approxStep = caseval(`regroup(evalf(${cleanInitialOut}))`).replace(/;$/, '').trim();
        if (
          approxStep &&
          approxStep !== 'undef' &&
          !approxStep.startsWith('GIAC_ERROR') &&
          !approxStep.toLowerCase().startsWith('error') &&
          !approxStep.includes('syntax error')
        ) {
          rawGiacOut = approxStep;
        }
      } else if (!SKIP_SIMPLIFY_RE.test(giacExpr.trim())) {
        const simplifiedStep = caseval(`simplify(${cleanInitialOut})`).replace(/;$/, '').trim();
        if (
          simplifiedStep &&
          simplifiedStep !== 'undef' &&
          !simplifiedStep.startsWith('GIAC_ERROR') &&
          !simplifiedStep.toLowerCase().startsWith('error') &&
          !simplifiedStep.includes('syntax error')
        ) {
          rawGiacOut = simplifiedStep;
        }
      }

      const rawOutput = rawGiacOut.replace(/^list\[/, '[');
      if (assignedSymbol) {
        caseval(`${assignedSymbol} := (${rawOutput})`);
      }
      const exactLatex = giacExprToLatex(rawOutput);
      const approxGiacOut = caseval(`regroup(evalf(${rawOutput}))`).replace(/;$/, '').trim();
      const approxRaw = approxGiacOut.replace(/^list\[/, '[');
      const approxLatex =
        approxRaw && !approxRaw.startsWith('GIAC_ERROR')
          ? giacExprToLatex(approxRaw)
          : exactLatex;

      lastAns = rawOutput;
      lastAnsLatex = exactLatex || rawOutput;
      if (assignedSymbol) {
        userVariables.set(assignedSymbol, rawOutput);
      }

      self.postMessage({
        id,
        status: 'OK',
        inputExpr: giacExpr,
        inputLatex: inputLatex || exactLatex,
        raw: rawOutput,
        approxRaw: approxRaw || rawOutput,
        exactLatex: exactLatex || rawOutput,
        approxLatex: approxLatex || approxRaw || rawOutput,
        variables: getVariablesSnapshot()
      });
    } catch (err) {
      self.postMessage({
        id,
        status: 'ERROR',
        inputExpr: expr,
        inputLatex: inputLatex || expr,
        error: err.message || 'Error de evaluación simbólica'
      });
    }
  }
};
