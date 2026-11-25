// cas.worker.js
// Web Worker dedicado para el motor simbólico Giac (giac.wasm) con parser 2D MathPrint (LaTeX <-> Giac) y catálogo TI-Nspire CX CAS

let caseval = null;
let isReady = false;
let lastAns = '0';
let lastAnsLatex = '0';
let currentAngleMode = 'RAD';
const userVariables = new Map();
const WORKER_VERSION = 'v1.42';

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

const RESERVED_MATH_IDS = new Set([
  'e', 'i', 'pi', 'infinity', 'sin', 'cos', 'tan', 'csc', 'sec', 'cot',
  'asin', 'acos', 'atan', 'acsc', 'asec', 'acot', 'sinh', 'cosh', 'tanh',
  'ln', 'log', 'log10', 'exp', 'sqrt', 'abs', 'sign', 'floor', 'ceil',
  'simplify', 'regroup', 'evalf', 'diff', 'integrate', 'subst', 'when'
]);

function detectDifferentialVar(diffGiacExpr, integrandGiacExpr = '') {
  const pickFromLname = (exprStr) => {
    if (!caseval) return [];
    const raw = caseval(`lname(${exprStr})`).replace(/;$/, '').trim();
    if (
      !raw ||
      raw === 'undef' ||
      raw.startsWith('GIAC_ERROR') ||
      raw.toLowerCase().startsWith('error') ||
      raw.includes('syntax error')
    ) {
      return [];
    }
    return extractScalarItems(raw)
      .map((v) => v.trim())
      .filter((v) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v) && !RESERVED_MATH_IDS.has(v));
  };

  let diffVars = pickFromLname(diffGiacExpr);
  if (diffVars.length === 0) {
    const matches = diffGiacExpr.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
    diffVars = matches.filter((v) => !RESERVED_MATH_IDS.has(v));
  }
  if (diffVars.length === 1) return diffVars[0];
  if (diffVars.length > 1) {
    if (integrandGiacExpr) {
      const intVars = pickFromLname(integrandGiacExpr);
      const shared = diffVars.find((v) => intVars.includes(v));
      if (shared) return shared;
    }
    return diffVars[0];
  }
  return 'x';
}

/**
 * Sustituye la letra normal `i` (como variable de índice en \sum_{i=...} o \prod_{i=...})
 * por un identificador interno seguro `idx_i_`, preservando comandos TeX como `\imaginaryI`, `\sin`, `\pi`, etc.
 */
function replacePlainIndexIInLatex(bodyStr) {
  const cmds = [];
  let s = bodyStr.replace(/\\[a-zA-Z]+/g, (m) => {
    const token = `\x00CMD${cmds.length}\x00`;
    cmds.push(m);
    return token;
  });
  // `2i` -> `2*idx_i_` y `i` aislada -> `idx_i_`
  s = s.replace(/([0-9])i(?![a-zA-Z0-9_])/g, '$1*idx_i_');
  s = s.replace(/(?<![a-zA-Z0-9_])i(?![a-zA-Z0-9_])/g, 'idx_i_');
  s = s.replace(/\x00CMD(\d+)\x00/g, (_, idx) => cmds[Number(idx)]);
  return s;
}

/**
 * Convierte pares balanceados de barras verticales simples `|...|` (escritas desde el teclado físico)
 * en `abs(...)`, dejando intactas barras sueltas `|` usadas como operador "tal que".
 */
function replacePlainAbsBars(str) {
  let s = str;
  const openPrevRe = /[(\[{,+\-*/^=<>!:|]$/;
  let safety = 0;
  while (s.includes('|') && safety++ < 50) {
    const stack = [];
    let matched = null;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '|') continue;
      // Determinar el carácter significativo anterior (saltando espacios)
      let p = i - 1;
      while (p >= 0 && /\s/.test(s[p])) p--;
      const prevChar = p >= 0 ? s[p] : '';
      const isOpen = p < 0 || openPrevRe.test(prevChar);
      if (isOpen) {
        stack.push(i);
      } else if (stack.length > 0) {
        const openIdx = stack.pop();
        matched = { openIdx, closeIdx: i };
        break;
      }
    }
    if (!matched) break;
    const inner = latexToGiac(s.slice(matched.openIdx + 1, matched.closeIdx));
    s = s.slice(0, matched.openIdx) + `abs(${inner})` + s.slice(matched.closeIdx + 1);
  }
  return s;
}

/**
 * Convierte el operando previo a cada símbolo de grados `°` a radianes `((operand)*pi/180)`
 * soportando números, variables (`x°`, `theta°`) y paréntesis arbitrariamente anidados (`((90)/(2))°`).
 */
function replaceDegreeOperands(expr) {
  let s = expr;
  let searchFrom = 0;
  while (true) {
    const degIdx = s.indexOf('°', searchFrom);
    if (degIdx === -1) break;
    let end = degIdx - 1;
    while (end >= 0 && /\s/.test(s[end])) end--;
    if (end < 0) {
      s = s.slice(0, degIdx) + s.slice(degIdx + 1);
      continue;
    }
    let start = end;
    if (s[end] === ')') {
      let depth = 1;
      start = end - 1;
      while (start >= 0 && depth > 0) {
        if (s[start] === ')') depth++;
        else if (s[start] === '(') depth--;
        start--;
      }
      start++;
    } else {
      while (start >= 0 && /[a-zA-Z0-9_.]/.test(s[start])) start--;
      start++;
    }
    const operand = s.slice(start, end + 1);
    if (operand) {
      const repl = `((${operand})*pi/180)`;
      s = s.slice(0, start) + repl + s.slice(degIdx + 1);
      searchFrom = start + repl.length;
    } else {
      s = s.slice(0, degIdx) + s.slice(degIdx + 1);
    }
  }
  return s;
}

const VALUE_TEX_CMD = 'pi|exponentialE|imaginaryI|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|rho|sigma|tau|phi|omega|Delta|Sigma|Omega';
const SPACE_MULT_SKIP_LEFT = new Set([
  'define', 'delvar', 'clearaz', 'and', 'or', 'not', 'xor', 'if', 'then', 'else', 'fi',
  'for', 'from', 'to', 'by', 'do', 'od', 'while', 'return', 'local',
  'sin', 'cos', 'tan', 'csc', 'sec', 'cot', 'asin', 'acos', 'atan', 'acsc', 'asec', 'acot',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'ln', 'log', 'log10', 'exp', 'sqrt',
  'abs', 'diff', 'integrate', 'limit', 'sum', 'product', 'solve', 'csolve', 'fsolve',
  'factor', 'expand', 'simplify', 'when', 'subst', 'select', 'convert'
]);
const SPACE_MULT_SKIP_RIGHT = new Set([
  'and', 'or', 'not', 'xor', 'then', 'else', 'do', 'to', 'fi', 'od'
]);

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

  // Normalizar \boxed{\mathrm{d}...} a \mathrm{d}\boxed{...} para el parser de integrales
  s = s.replace(/\\boxed\s*\{\s*(?:\\mathrm\{\s*d\s*\}|\\differentialD)\s*/g, '\\mathrm{d}\\boxed{');

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

  // Proteger operador "tal que" (\mid / \vert) antes de procesar barras de valor absoluto
  s = s.replace(/\\mid\b|\\vert\b/g, ' @@SUCHTHAT@@ ');

  // Valor absoluto balanceado \left| ... \right| (soporta anidación arbitraria incluso con fracciones dentro)
  while (/\\left\s*\|/.test(s)) {
    const mStart = /\\left\s*\|/.exec(s);
    const start = mStart.index;
    let i = start + mStart[0].length;
    let depth = 1;
    let closeStart = -1;
    let closeEnd = -1;
    while (i < s.length && depth > 0) {
      const rest = s.slice(i);
      const mOpen = rest.match(/^\\left\s*\|/);
      if (mOpen) {
        depth++;
        i += mOpen[0].length;
        continue;
      }
      const mClose = rest.match(/^\\right\s*\|/);
      if (mClose) {
        depth--;
        if (depth === 0) {
          closeStart = i;
          closeEnd = i + mClose[0].length;
          break;
        }
        i += mClose[0].length;
        continue;
      }
      i++;
    }
    if (closeStart !== -1) {
      const inner = latexToGiac(s.slice(start + mStart[0].length, closeStart));
      s = s.slice(0, start) + `abs(${inner})` + s.slice(closeEnd);
    } else {
      break;
    }
  }

  // Valor absoluto con barras simples del teclado físico `|...|`
  if (s.includes('|')) {
    s = replacePlainAbsBars(s);
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

  // Multiplicación implícita antes de funciones matemáticas, operadores 2D y constantes (ej. x\sin(x) -> x*\sin(x), 2\pi -> 2*\pi, x\sum_{i=1} -> x*\sum_{i=1})
  // Se ignora si el prefijo es un comando TeX (como \int, \sum, \lim). Se usa (?![a-zA-Z]) en vez de \b porque '_' es \w en regex (\log_, \sum_, \int_).
  const fnTokenList = 'sin|cos|tan|csc|sec|cot|arcsin|arccos|arctan|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|sqrt|sum|prod|lim|int|pi|exponentialE|imaginaryI';
  const implicitFnRegex = new RegExp('(\\\\?[a-zA-Z0-9_]+|\\))\\s*(\\\\(' + fnTokenList + ')(?![a-zA-Z]))', 'g');
  s = s.replace(implicitFnRegex, (match, prefix, fnCmd) => {
    if (prefix.startsWith('\\')) return match;
    return prefix + '*' + fnCmd;
  });

  // Multiplicación implícita entre constantes/griegas (\pi, \theta, \imaginaryI, ...) y funciones/operadores TeX
  // Se ejecuta ANTES de quitar '\' a \sin, \cos, \ln, \log, \sqrt, \sum, \prod, \lim para evitar fusiones como \pisin o \pisum
  const earlyAdjValueTexRe = new RegExp(
    '(\\\\(?:(?:' + VALUE_TEX_CMD + '))(?![a-zA-Z]))\\s*(?=\\\\(?:' + VALUE_TEX_CMD + '|sin|cos|tan|csc|sec|cot|sinh|cosh|tanh|arcsin|arccos|arctan|asin|acos|atan|ln|log|exp|sqrt|sum|prod|lim|int|frac)(?![a-zA-Z]))',
    'g'
  );
  s = s.replace(earlyAdjValueTexRe, '$1*');

  // Potencias sobre funciones trigonométricas/hiperbólicas/ln: \sin^{2}(x) -> (\sin(x))^{2} (excepto ^{-1} inversas)
  {
    const trigPowRe = /\\(sin|cos|tan|csc|sec|cot|sinh|cosh|tanh|ln)\s*\^/;
    let m;
    while ((m = trigPowRe.exec(s)) !== null) {
      const fnName = m[1];
      const caretEnd = m.index + m[0].length;
      const expBlock = extractTexArg(s, caretEnd);
      if (!expBlock) break;
      if (expBlock.content.trim() === '-1' && fnName !== 'ln') {
        s = s.slice(0, m.index) + `a${fnName}` + s.slice(expBlock.endIdx);
        continue;
      }
      const afterExp = skipSpaces(s, expBlock.endIdx);
      const argBlock = s[afterExp] === '(' ? extractBalanced(s, afterExp, '(', ')') : extractTexArg(s, afterExp);
      if (!argBlock) break;
      s =
        s.slice(0, m.index) +
        `(${fnName}(${argBlock.content}))^{${expBlock.content}}` +
        s.slice(argBlock.endIdx);
    }
  }

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
      const rawIndexVar = (eqSplit[0] || 'k').trim();
      let vName;
      let processedBody = bodyStr;
      // Permitir el índice clásico `i` (teclado) en sumatorias/productorias sin chocar con \imaginaryI (√-1)
      if (rawIndexVar === 'i') {
        vName = 'idx_i_';
        processedBody = replacePlainIndexIInLatex(bodyStr);
      } else {
        vName = latexToGiac(rawIndexVar);
      }
      const vLow = latexToGiac(eqSplit[1] || '1');
      const vUp = latexToGiac(upPart || 'n');
      const vBody = latexToGiac(processedBody);
      s = s.slice(0, idx) + `${giacFn}(${vBody}, ${vName}, ${vLow}, ${vUp})` + s.slice(cur);
    }
  }

  // Límite \lim_{x \to a}(expr), incluyendo límites laterales \lim_{x \to a^{+}} y \lim_{x \to a^{-}}
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
    let rawPt = (toSplit[1] || '0').trim();
    let limitDir = 0;
    if (/\^\s*(?:\{\s*\+\s*\}|\+)\s*$/.test(rawPt)) {
      limitDir = 1;
      rawPt = rawPt.replace(/\^\s*(?:\{\s*\+\s*\}|\+)\s*$/, '').trim();
    } else if (/\^\s*(?:\{\s*-\s*\}|-)\s*$/.test(rawPt)) {
      limitDir = -1;
      rawPt = rawPt.replace(/\^\s*(?:\{\s*-\s*\}|-)\s*$/, '').trim();
    }
    const vPt = latexToGiac(rawPt || '0');
    const vBody = latexToGiac(bodyStr);
    const limitCall =
      limitDir !== 0
        ? `limit(${vBody}, ${vName}, ${vPt}, ${limitDir})`
        : `limit(${vBody}, ${vName}, ${vPt})`;
    s = s.slice(0, idx) + limitCall + s.slice(cur);
  }

  // Integrales definidas e indefinidas: soporta recuadros \boxed{...} y diferenciales compuestos d(g(x))
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

    let integrandRaw = null;
    let diffRaw = null;
    let afterIdx = -1;

    const curAfterLim = skipSpaces(s, cur);
    if (s.startsWith('\\boxed', curAfterLim)) {
      const boxBlock = extractTexArg(s, curAfterLim + 6);
      if (boxBlock) {
        integrandRaw = boxBlock.content;
        let dCur = skipSpaces(s, boxBlock.endIdx);
        const sepMatch = s.slice(dCur).match(/^(?:\\cdot|\\times|\*|\s)+/);
        if (sepMatch) dCur += sepMatch[0].length;
        const dPrefix = s.slice(dCur).match(/^(?:\\differentialD|d(?![a-zA-Z_]))\s*/);
        if (dPrefix) {
          const vCur = skipSpaces(s, dCur + dPrefix[0].length);
          if (s.startsWith('\\boxed', vCur)) {
            const diffBoxBlock = extractTexArg(s, vCur + 6);
            if (diffBoxBlock) {
              diffRaw = diffBoxBlock.content;
              afterIdx = diffBoxBlock.endIdx;
            }
          } else if (s[vCur] === '(') {
            const parenBlock = extractBalanced(s, vCur, '(', ')');
            if (parenBlock) {
              diffRaw = parenBlock.content;
              afterIdx = parenBlock.endIdx;
            }
          } else {
            const varMatch = s.slice(vCur).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
            if (varMatch) {
              diffRaw = varMatch[1];
              afterIdx = vCur + varMatch[1].length;
            }
          }
        }
      }
    }

    if (afterIdx === -1) {
      const rest = s.slice(cur);
      const dMatch = rest.match(/(?:\\differentialD|\bd)\s*/);
      if (dMatch) {
        const dStartInRest = dMatch.index;
        const afterDPos = cur + dStartInRest + dMatch[0].length;
        if (s.startsWith('\\boxed', afterDPos)) {
          const diffBoxBlock = extractTexArg(s, afterDPos + 6);
          if (diffBoxBlock) {
            integrandRaw = rest.slice(0, dStartInRest).replace(/(?:\\cdot|\\times|\*|\s)+$/, '').trim();
            diffRaw = diffBoxBlock.content;
            afterIdx = diffBoxBlock.endIdx;
          }
        } else if (s[afterDPos] === '(') {
          const parenBlock = extractBalanced(s, afterDPos, '(', ')');
          if (parenBlock) {
            integrandRaw = rest.slice(0, dStartInRest).replace(/(?:\\cdot|\\times|\*|\s)+$/, '').trim();
            diffRaw = parenBlock.content;
            afterIdx = parenBlock.endIdx;
          }
        } else {
          const varMatch = s.slice(afterDPos).match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
          if (varMatch) {
            integrandRaw = rest.slice(0, dStartInRest).replace(/(?:\\cdot|\\times|\*|\s)+$/, '').trim();
            diffRaw = varMatch[1];
            afterIdx = afterDPos + varMatch[1].length;
          }
        }
      }
    }

    if (afterIdx !== -1 && diffRaw !== null) {
      const integrand = latexToGiac((integrandRaw || '').trim() || '1');
      const diffExpr = stripOuterParensAndList(latexToGiac(diffRaw.trim() || 'x'));
      let giacInt;
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(diffExpr)) {
        giacInt =
          lowStr !== null && upStr !== null
            ? `(integrate(${integrand}, ${diffExpr}, ${lowStr}, ${upStr}))`
            : `(integrate(${integrand}, ${diffExpr}))`;
      } else {
        const varName = detectDifferentialVar(diffExpr, integrand);
        giacInt =
          lowStr !== null && upStr !== null
            ? `(integrate((${integrand}) * diff(${diffExpr}, ${varName}), ${varName}, ${lowStr}, ${upStr}))`
            : `(integrate((${integrand}) * diff(${diffExpr}, ${varName}), ${varName}))`;
      }
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

    // Comprobar si es plantilla de derivada: \frac{d}{dx}(expr), \frac{d}{d\theta}(expr), \frac{d^{n}}{dx_{1}^{n}}(expr)
    const derivNumMatch = numRaw.match(/^(?:\\differentialD|d)(?:\^\s*(?:\{([^}]+)\}|(\d+|[a-zA-Z])))?$/);
    let derivDenParsed = null;
    if (derivNumMatch) {
      const mPrefix = denRaw.match(/^(?:\\differentialD|d)\s*(.+)$/);
      if (mPrefix) {
        let rest = mPrefix[1].trim();
        let denOrder = null;
        const mExp = rest.match(/\^\s*(?:\{([^}]+)\}|(\d+|[a-zA-Z]))\s*$/);
        if (mExp) {
          denOrder = (mExp[1] || mExp[2] || '').trim();
          rest = rest.slice(0, mExp.index).trim();
        }
        if (rest) {
          const candidateVar = latexToGiac(rest);
          if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidateVar) && !RESERVED_MATH_IDS.has(candidateVar)) {
            derivDenParsed = { vName: candidateVar, denOrder };
          }
        }
      }
    }

    if (derivNumMatch && derivDenParsed) {
      const numOrder = (derivNumMatch[1] || derivNumMatch[2] || '').trim();
      const orderRaw = numOrder || derivDenParsed.denOrder || '1';
      const order = orderRaw === '1' ? '1' : latexToGiac(orderRaw);
      const vName = derivDenParsed.vName;
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
        s = s.slice(0, idx) + `@@POW@@(${innerExp})` + s.slice(expBlock.endIdx);
        continue;
      }
    }
    s = s.slice(0, idx) + '@@POW@@' + s.slice(idx + 1);
  }
  s = s.replace(/@@POW@@/g, '^');

  // Subíndices _{...} -> _...
  while (s.includes('_')) {
    const idx = s.indexOf('_');
    const cur = skipSpaces(s, idx + 1);
    if (s[cur] === '{') {
      const subBlock = extractBalanced(s, cur, '{', '}');
      if (subBlock) {
        s = s.slice(0, idx) + '@@SUB@@' + latexToGiac(subBlock.content) + s.slice(subBlock.endIdx);
        continue;
      }
    }
    s = s.slice(0, idx) + '@@SUB@@' + s.slice(idx + 1);
  }
  s = s.replace(/@@SUB@@/g, '_');

  // Recuadros generales \boxed{...} -> (...)
  while (s.includes('\\boxed')) {
    const idx = s.indexOf('\\boxed');
    const b = extractTexArg(s, idx + 6);
    if (!b) break;
    s = s.slice(0, idx) + `(${latexToGiac(b.content)})` + s.slice(b.endIdx);
  }

  // Bloques residuales entre llaves {a} -> (a)
  while (s.includes('{')) {
    const idx = s.indexOf('{');
    const b = extractBalanced(s, idx, '{', '}');
    if (!b) break;
    s = s.slice(0, idx) + `(${latexToGiac(b.content)})` + s.slice(b.endIdx);
  }

  // Multiplicación implícita antes y entre constantes/letras griegas (\pi\imaginaryI, \imaginaryI\pi, \pi\theta, \alpha\beta, 2\theta)
  const prefixValueTexRe = new RegExp('(\\\\?[a-zA-Z0-9_]+|\\)|\\])\\s*(\\\\(?:(?:' + VALUE_TEX_CMD + '))\\b)', 'g');
  s = s.replace(prefixValueTexRe, (match, pre, cmd) => (pre.startsWith('\\') ? match : `${pre}*${cmd}`));
  const adjValueTexRe = new RegExp(
    '(\\\\(?:(?:' + VALUE_TEX_CMD + '))\\b)\\s*(?=\\\\(?:' + VALUE_TEX_CMD + '|sin|cos|tan|csc|sec|cot|sinh|cosh|tanh|arcsin|arccos|arctan|ln|log|exp|sqrt)\\b)',
    'g'
  );
  s = s.replace(adjValueTexRe, '$1*');
  const valueTexParenRe = new RegExp('(\\\\(?:(?:' + VALUE_TEX_CMD + '))\\b)\\s*(?=\\()', 'g');
  s = s.replace(valueTexParenRe, '$1*');

  // Símbolos constantes, grados, operadores relacionales y letras griegas en LaTeX
  s = s
    .replace(/\^\s*\(\s*\\circ\s*\)/g, '°')
    .replace(/\^\s*\\circ\b/g, '°')
    .replace(/\\degree\b/g, '°')
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
  s = s.replace(/\)\s*(?!(?:and|or|not|xor|then|else|do|to)\b)(?=[a-zA-Z0-9_(])/gi, ')*');

  // Multiplicación implícita separada por espacios entre constantes/variables (ej. 2*pi x -> 2*pi*x, x y -> x*y)
  if (!/^\s*DelVar\b/i.test(s)) {
    s = s.replace(/([a-zA-Z0-9_]+)[ \t]+(?=([a-zA-Z0-9_]+))/g, (match, leftTok, rightTok) => {
      if (SPACE_MULT_SKIP_LEFT.has(leftTok.toLowerCase())) return match;
      if (SPACE_MULT_SKIP_RIGHT.has(rightTok.toLowerCase())) return match;
      return `${leftTok}*`;
    });
  }

  // Restaurar marcador de operador "tal que" (\mid / \vert)
  s = s.replace(/@@SUCHTHAT@@/g, '|');

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

      const getMatrixDims = (expr) => {
        const d = evalClean(`dim(${expr})`);
        const m = d.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
        return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
      };
      const isGiacList = (expr) => {
        if (getMatrixDims(expr)) return false;
        const ev = evalClean(expr).replace(/^list\[/, '[');
        return isValidGiacOut(ev) && ev.startsWith('[') && ev.endsWith(']');
      };

      // Caso 1: solve(A * x = B, x) donde A es matriz (ncols > 1), B es vector/matriz y x es un identificador simple
      if (eqArgs.length === 1 && varArgs.length === 1 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varArgs[0].trim())) {
        const eqParts = splitTopLevelArgs(eqArgs[0], '=');
        if (eqParts.length === 2) {
          const [lhs, rhs] = eqParts;
          const v = varArgs[0].trim();
          const rhsDims = getMatrixDims(rhs);
          const rhsIsList = isGiacList(rhs);
          if (rhsDims || rhsIsList) {
            const matA = evalClean(`subst(${lhs}, ${v}=1)`);
            const aDims = getMatrixDims(matA);
            if (aDims && aDims.cols > 1) {
              const rhsCol = rhsDims
                ? rhsDims.rows === 1 && aDims.rows > 1
                  ? `tran(${rhs})`
                  : rhs
                : `tran([${rhs}])`;
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
        const aDims = getMatrixDims(candA);
        const noVarsInAB = evalClean(`lname([${candA}, ${candB}])`) === '[]';
        if (aDims && noVarsInAB) {
          const bDims = getMatrixDims(candB);
          const bIsList = isGiacList(candB);
          if (bDims) {
            const rhsCol = bDims.rows === 1 && aDims.rows > 1 ? `tran(${candB})` : candB;
            return `simult(${candA}, ${rhsCol})`;
          } else if (bIsList) {
            return `simult(${candA}, tran([${candB}]))`;
          }
        }
      }

      // Caso 3: solve(M) donde M es una matriz aumentada numérica n × (n+1)
      if (eqArgs.length === 1 && splitTopLevelArgs(eqArgs[0], '=').length === 1) {
        const M = eqArgs[0];
        const mDims = getMatrixDims(M);
        if (mDims && evalClean(`lname(${M})`) === '[]') {
          const r = mDims.rows;
          const c = mDims.cols;
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
  s = replaceFunctionCalls(s, 'polyCoeffs', (a) => `convert(symb2poly(${a.join(', ')}), list)`);

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
    return `convert(taylor(${expr}, ${v}=${pt}, ${order}), polynom)`;
  });

  // 4. Menú Probabilidad y Estadística
  s = replaceFunctionCalls(s, 'nPr', (a) => `perm(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'nCr', (a) => `comb(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'randInt', (a) => `randint(${a.join(', ')})`);
  // Mediana estándar (promedio de los dos valores centrales cuando el tamaño de la lista es par)
  s = replaceFunctionCalls(
    s,
    'median',
    (a) => `((L_med -> (sort(L_med)[floor((size(L_med)-1)/2)] + sort(L_med)[floor(size(L_med)/2)]) / 2)(${a.join(', ')}))`
  );
  // Alias compatibles TI-84/TI-89 (muestrales ÷(n-1)) — se procesan ANTES de stDevPop/varPop para evitar colisión case-insensitive
  s = replaceFunctionCalls(s, 'stdDev', (a) => `stddevp(${a.join(', ')})`);
  s = replaceFunctionCalls(
    s,
    'variance',
    (a) => `((L_var -> variance(L_var)*size(L_var)/(size(L_var)-1))(${a.join(', ')}))`
  );
  // Comandos oficiales TI-Nspire CX CAS (muestral vs. poblacional)
  s = replaceFunctionCalls(s, 'stDevSamp', (a) => `stddevp(${a.join(', ')})`);
  s = replaceFunctionCalls(s, 'stDevPop', (a) => `stddev(${a.join(', ')})`);
  s = replaceFunctionCalls(
    s,
    'varSamp',
    (a) => `((L_var -> variance(L_var)*size(L_var)/(size(L_var)-1))(${a.join(', ')}))`
  );
  s = replaceFunctionCalls(s, 'varPop', (a) => `variance(${a.join(', ')})`);
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
    return `when(abs((${area}) - 1/2) < 1e-15, ${mu}, evalf(normald_icdf(${mu}, ${sigma}, ${area})))`;
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
    return `when(abs((${area}) - 1/2) < 1e-15, 0, evalf(studentd_icdf(${df}, ${area})))`;
  });
  s = replaceFunctionCalls(s, 'chi2Pdf', (a) => {
    const [x, df] = a;
    return `chisquared(${df}, ${x})`;
  });
  s = replaceFunctionCalls(s, 'chi2Cdf', (a) => {
    const [low, up, df] = a;
    return `evalf(chisquared_cdf(${df}, ${up}) - chisquared_cdf(${df}, ${low}))`;
  });
  s = replaceFunctionCalls(s, 'invChi2', (a) => {
    const [area, df] = a;
    return `evalf(chisquared_icdf(${df}, ${area}))`;
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
  s = replaceFunctionCalls(s, 'eigVl', (a) => `[eigenvals(${a.join(', ')})]`);
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

  // Verificar protección de solo lectura de Ans ANTES de sustituir Ans por su valor
  if (/^\s*ans(?:\s*\([^)]*\))?\s*:=/i.test(expr)) {
    throw new Error('Ans es una variable automática de solo lectura.');
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
    expr = replaceDegreeOperands(expr);
  } else {
    expr = expr.replace(/°/g, '');
  }

  expr = expr.replace(/\b(?:Ans|ans)\b/g, `(${lastAns})`);

  // Operador "tal que" (|): sustituciones (x=3, y=4), filtrado de soluciones (solve(...) | x > 0) o suposiciones simbólicas
  let tempAssumptions = null;
  const pipeParts = splitTopLevelArgs(expr, '|');
  if (pipeParts.length === 2) {
    const baseExpanded = expandTIFunctions(pipeParts[0]);
    const condRaw = expandTIFunctions(pipeParts[1]);
    const commaConds = splitTopLevelArgs(condRaw, ',');
    const hasInequality = /(?:<=|>=|!=|<|>)/.test(condRaw);

    if (!hasInequality) {
      const eqConds = [];
      for (const c of commaConds) {
        for (const sub of c.split(/\band\b/i)) {
          const trimmed = sub.trim();
          if (trimmed) eqConds.push(trimmed);
        }
      }
      expr = `subst(${baseExpanded}, [${eqConds.join(', ')}])`;
    } else {
      const combinedCond = commaConds.map((c) => `(${c})`).join(' and ');
      const isListBase =
        /^(?:solve|csolve|fsolve|zeros|cZeros|proot)\s*\(/i.test(baseExpanded.trim()) ||
        baseExpanded.trim().startsWith('[');
      if (isListBase) {
        const filterVar = detectDifferentialVar(combinedCond);
        expr = `select(${filterVar} -> (${combinedCond}), ${baseExpanded})`;
      } else {
        const assumeConds = [];
        for (const c of commaConds) {
          for (const sub of c.split(/\band\b/i)) {
            const trimmed = sub.trim();
            if (trimmed) assumeConds.push(trimmed);
          }
        }
        tempAssumptions = assumeConds;
        expr = baseExpanded;
      }
    }
  } else {
    expr = expandTIFunctions(expr);
  }

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
    tempAssumptions,
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

function giacExprToLatex(exprStr, preserveUnevaluated = false) {
  if (!exprStr) return '';
  let rawLatex = caseval(preserveUnevaluated ? `latex(quote(${exprStr}))` : `latex(${exprStr})`).replace(/;$/, '').trim();
  if (
    !rawLatex ||
    rawLatex === 'undef' ||
    rawLatex.startsWith('GIAC_ERROR') ||
    rawLatex.toLowerCase().startsWith('error') ||
    rawLatex.includes('syntax error')
  ) {
    rawLatex = caseval(preserveUnevaluated ? `latex(${exprStr})` : `latex(quote(${exprStr}))`).replace(/;$/, '').trim();
  }
  let s = rawLatex;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Restaurar índice interno de sumatorias/productorias (idx_i_ -> i) y compatibilidad KaTeX (\mbox -> \text)
  s = s
    .replace(/\\mathrm\{idx\\_i\\_\}|idx\\_i\\_/g, 'i')
    .replace(/\\mbox\s*\{/g, '\\text{');
  s = s
    .replace(/\\mathrm\{(?!order\\_size\b)([a-zA-Z]+)\\_([a-zA-Z0-9]+)\}/g, '$1_{$2}')
    .replace(/(?!order\\_size\b)([a-zA-Z0-9])\\_([a-zA-Z0-9]+)/g, '$1_{$2}');
  // Reagrupar \sqrt{n}\cdot\sqrt{\pi} -> \sqrt{n\pi} (para enteros positivos n, p. ej. normPdf)
  s = s.replace(/\\sqrt\{(\d+)\}\s*(?:\\cdot\s*)?\\sqrt\{\\pi\s*\}/g, '\\sqrt{$1\\pi}');
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
    const assumedVarsToPurge = [];
    try {
      const { isDelVar, targetVars, assignedSymbol, isFunctionDef, tempAssumptions, giacExpr } = transpileTISyntax(expr);

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

      if (tempAssumptions && tempAssumptions.length > 0) {
        const condKeywordSkip = new Set(['and', 'or', 'not', 'xor', 'true', 'false']);
        for (const cond of tempAssumptions) {
          const condSymbols = (cond.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || []).filter(
            (v) => !RESERVED_MATH_IDS.has(v) && !condKeywordSkip.has(v.toLowerCase())
          );
          // No aplicar assume() si alguna variable de la condición ya tiene un valor guardado por el usuario
          if (condSymbols.some((v) => userVariables.has(v))) {
            continue;
          }
          for (const v of condSymbols) {
            if (!assumedVarsToPurge.includes(v)) {
              assumedVarsToPurge.push(v);
            }
          }
          caseval(`assume(${cond})`);
        }
      }

      const SKIP_SIMPLIFY_RE = /^(?:[a-zA-Z_][a-zA-Z0-9_]*\s*:=\s*\(?\s*)?(?:factor|cfactor|ifactor|canonical_form|convert\s*\(\s*taylor|taylor|series|partfrac|propfrac|expand|texpand|tcollect|rref|ref|egvl|egv|\[?\s*eigenvals|simult|solve|csolve|nsolve|zeros|czeros|desolve|select)\s*\(/i;
      const skipSimplify = SKIP_SIMPLIFY_RE.test(giacExpr.trim());
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

      const cleanInitialOut = rawGiacOut.replace(/^(?:list|matrix)\[/, '[');
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
      } else if (!skipSimplify) {
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

      const rawOutput = rawGiacOut.replace(/^(?:list|matrix)\[/, '[');
      if (assignedSymbol) {
        caseval(`${assignedSymbol} := (${rawOutput})`);
      }
      const exactLatex = giacExprToLatex(rawOutput, skipSimplify && !forceApprox);
      const approxGiacOut = caseval(`regroup(evalf(${rawOutput}))`).replace(/;$/, '').trim();
      const approxRaw = approxGiacOut.replace(/^(?:list|matrix)\[/, '[');
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
    } finally {
      for (const v of assumedVarsToPurge) {
        caseval(`purge(${v})`);
      }
    }
  }
};
