// Reads the project's own types with the project's own TypeScript compiler: finds the code that
// calls an endpoint, works out what it expects back, and builds a sample value of that type.
// Works for TypeScript and for JavaScript with JSDoc types (allowJs/checkJs).
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { booleanFor, dateFor, isDateName, numberFor, stringFor } from './sample-data.mjs';
import { TOOL_HOME } from './util.mjs';

const TEST_FILE = /(^|\/)(e2e|tests?|__tests__|__mocks__|cypress|playwright|mocks?|fixtures?|stories)\/|\.(spec|test|stories|story|cy)\.[cm]?[jt]sx?$/;

export function loadTypeScript(fromDir) {
  const candidates = [process.env.UI_CHANGELOG_TYPESCRIPT, ...ancestors(fromDir).map((dir) => path.join(dir, 'node_modules', 'typescript')), path.join(TOOL_HOME, 'node_modules', 'typescript')].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const ts = createRequire(path.join(fromDir, 'noop.js'))(candidate);
      if (typeof ts.createProgram === 'function') return ts;
    } catch {
      // Not a usable compiler API (for example a native-only TypeScript build); try the next one.
    }
  }
  return { error: `No TypeScript compiler API found in node_modules of ${fromDir} or its parents, nor in ${TOOL_HOME}. Install the project's dependencies, or set UI_CHANGELOG_TYPESCRIPT to a typescript package directory.` };
}

function ancestors(dir) {
  const out = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    out.push(current);
    if (path.dirname(current) === current) return out;
  }
}

// A solution-style tsconfig ("files": [] plus references) is expanded into its referenced projects.
export function openProject(ts, configPath) {
  const roots = new Set();
  let options;
  const visit = (file, depth) => {
    const resolved = existsSync(file) && statSync(file).isDirectory() ? path.join(file, 'tsconfig.json') : file;
    const read = ts.readConfigFile(resolved, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(resolved), undefined, resolved);
    if (parsed.fileNames.length && !options) options = parsed.options;
    for (const name of parsed.fileNames) roots.add(name);
    if (depth < 3) for (const reference of parsed.projectReferences ?? []) visit(reference.path, depth + 1);
  };
  visit(path.resolve(configPath), 0);
  if (!roots.size) throw new Error(`${configPath} includes no source files`);
  const program = ts.createProgram({ rootNames: [...roots], options: { ...options, noEmit: true, skipLibCheck: true } });
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes('/node_modules/'));
  return { ts, program, checker: program.getTypeChecker(), files, root: path.dirname(path.resolve(configPath)) };
}

// Every string, template or concatenation that looks like a URL path, with constant parts resolved.
function urlLiterals(project) {
  if (project.literals) return project.literals;
  const { ts, checker } = project;
  const literals = [];
  const constantText = (node) => {
    const type = checker.getTypeAtLocation(node);
    if (type.isStringLiteral?.() || type.isNumberLiteral?.()) return String(type.value);
    return null;
  };
  const partsOf = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text];
      for (const span of node.templateSpans) parts.push(constantText(span.expression) ?? null, span.literal.text);
      return parts;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const side = (child) => (ts.isStringLiteral(child) || ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child) || ts.isBinaryExpression(child) ? (partsOf(child) ?? [null]) : [constantText(child)]);
      return [...side(node.left), ...side(node.right)];
    }
    return null;
  };
  // Tests and stories hold route globs and fixtures, not the app's own calls.
  // A constant passed straight to client.get/post/... (http.post(PREFIX, body)) is a URL too.
  const isClientArgument = (node) => (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && ts.isCallExpression(node.parent) && node.parent.arguments[0] === node && ts.isPropertyAccessExpression(node.parent.expression) && /^(get|post|put|patch|delete|head|request|fetch)$/i.test(node.parent.expression.name.text);
  for (const file of project.files.filter((candidate) => !TEST_FILE.test(path.relative(project.root, candidate.fileName)))) {
    const walk = (node) => {
      const parts = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ? partsOf(node) : isClientArgument(node) ? [constantText(node)] : null;
      if (parts && parts.some((part) => part?.includes('/')) && !isModuleSpecifier(ts, node) && !isUiLink(ts, node)) {
        const urlParts = untilQuery(parts);
        const text = urlParts.map((part) => part ?? '*').join('');
        const literal = urlParts.filter((part) => part !== null).join('').replace(/[^A-Za-z]/g, '');
        if (literal.length >= 2 && !urlParts.some((part) => part?.includes('*')) && !/^[a-z]+:\/\/[^/]+\/?$/.test(text)) {
          const source = urlParts.map((part) => (part === null ? '[^/?#]+' : escapeRegExp(part))).join('');
          literals.push({ node, file, text, score: literal.length, pattern: new RegExp(`(?:^|/)${source.replace(/^\//, '')}/?$`) });
          return; // The outermost expression describes the whole URL.
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  project.literals = literals;
  return literals;
}

// The path part of a URL expression: everything before the first literal "?" or "#".
function untilQuery(parts) {
  const out = [];
  for (const part of parts) {
    if (part !== null && /[?#]/.test(part)) {
      out.push(part.split(/[?#]/)[0]);
      break;
    }
    out.push(part);
  }
  return out;
}

function isModuleSpecifier(ts, node) {
  const parent = node.parent;
  return Boolean(parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isLiteralTypeNode(parent) || (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')))));
}

// Paths in JSX (<Link to="/event/1">) and navigation calls are routes in the app, not API calls.
function isUiLink(ts, node) {
  for (let current = node.parent, depth = 0; current && depth < 6; current = current.parent, depth++) {
    if (ts.isJsxAttribute(current) || ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return true;
    if (ts.isCallExpression(current)) {
      const callee = ts.isPropertyAccessExpression(current.expression) ? current.expression.name.text : ts.isIdentifier(current.expression) ? current.expression.text : '';
      if (/^(navigate|redirect|push|replace|assign|open|Navigate|useNavigate|goto|navigateTo)$/.test(callee)) return true;
    }
    if (ts.isFunctionLike(current)) return false;
  }
  return false;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Call sites whose URL matches the request path, best match first. For GraphQL, the operation name
// decides. When the code shows its HTTP method, a site with the request's method wins over the rest.
export function findCallSites(project, { pathname, operation, method }) {
  const sites = callSites(project, { pathname, operation });
  if (!method) return sites;
  const same = sites.filter((site) => site.method === method);
  const unknown = sites.filter((site) => !site.method);
  return same.length ? [...same, ...unknown] : unknown.length ? unknown : sites;
}

function callSites(project, { pathname, operation }) {
  const { ts } = project;
  if (operation) {
    const hits = [];
    for (const file of project.files) {
      const walk = (node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && new RegExp(`\\b(query|mutation|subscription)\\s+${operation}\\b|^${operation}$`).test(node.getText(file).replace(/^[`'"]|[`'"]$/g, ''))) {
          hits.push({ node, file, text: operation, score: 100 });
        }
        ts.forEachChild(node, walk);
      };
      walk(file);
    }
    if (hits.length) return hits.map((hit) => describeSite(project, hit));
  }
  const matches = urlLiterals(project).filter((literal) => literal.pattern.test(pathname));
  const best = Math.max(0, ...matches.map((match) => match.score));
  return matches.filter((match) => match.score === best).map((match) => describeSite(project, match));
}

function describeSite(project, { node, file, text }) {
  const { ts, checker } = project;
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  const site = { file: path.relative(project.root, file.fileName), line: position.line + 1, url: text, method: httpMethod(ts, node, file) };
  // httpClient.get<T>(url), request<T>(url), useQuery<T>(...): the type argument is the response.
  for (let current = node.parent, depth = 0; current && depth < 4; current = current.parent, depth++) {
    if (ts.isCallExpression(current) && current.typeArguments?.length) {
      site.type = checker.getTypeFromTypeNode(current.typeArguments[0]);
      site.via = `${current.expression.getText(file)}<${current.typeArguments[0].getText(file)}>()`;
      break;
    }
    if (ts.isFunctionLike(current)) break;
  }
  const fn = enclosingFunction(ts, node);
  if (fn) {
    site.function = functionName(ts, fn, file);
    site.functionNode = fn;
    if (!site.type) {
      const signature = checker.getSignatureFromDeclaration(fn);
      if (signature) {
        site.type = responseType(project, checker.getReturnTypeOfSignature(signature));
        site.via = `${site.function}(): ${checker.typeToString(checker.getReturnTypeOfSignature(signature))}`;
      }
    }
    // A subscribe(callback) helper: the callback's first parameter is the message type.
    site.messageType = callbackParameterType(project, fn);
  }
  // fetch() resolves to an untyped Response; any and unknown say nothing about the body either.
  const typeSymbol = site.type?.getSymbol?.()?.getName() ?? site.type?.aliasSymbol?.getName();
  if (site.type && (site.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void) || ['Response', 'Blob', 'ArrayBuffer', 'Element', 'ReactElement', 'ReactNode', 'VNode', 'TemplateResult', 'SVGElement', 'HTMLElement'].includes(typeSymbol))) delete site.type;
  if (site.type) site.typeName = checker.typeToString(site.type);
  return site;
}

// client.get(url), api.post(url, body), fetch(url, { method: 'PUT' }): the method the code sends.
function httpMethod(ts, node, file) {
  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
  for (let current = node, depth = 0; current?.parent && depth < 3; current = current.parent, depth++) {
    const call = current.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(current)) continue;
    if (ts.isPropertyAccessExpression(call.expression) && METHODS.includes(call.expression.name.text.toLowerCase())) return call.expression.name.text.toUpperCase();
    const init = call.arguments[call.arguments.indexOf(current) + 1];
    if (init && ts.isObjectLiteralExpression(init)) {
      const property = init.properties.find((candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText(file) === 'method');
      if (property && ts.isStringLiteralLike(property.initializer)) return property.initializer.text.toUpperCase();
    }
    return call.arguments.indexOf(current) === 0 && /fetch$/i.test(call.expression.getText(file)) ? 'GET' : undefined;
  }
  return undefined;
}

function enclosingFunction(ts, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // A small arrow inside a named function (fetch(...).then(r => r.json())) belongs to that function.
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && !ts.isVariableDeclaration(current.parent) && !ts.isPropertyAssignment(current.parent)) continue;
      return current;
    }
  }
  return null;
}

function functionName(ts, fn, file) {
  if (fn.name) return fn.name.getText(file);
  if (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)) return fn.parent.name.getText(file);
  return 'anonymous function';
}

// Promise<T> → T, and an HTTP client's response wrapper ({ data, status, headers }) → its data.
function responseType(project, type) {
  const { checker } = project;
  let result = checker.getAwaitedType?.(type) ?? type;
  const names = new Set(checker.getPropertiesOfType(result).map((symbol) => symbol.name));
  if (names.has('data') && names.has('status') && names.has('headers')) {
    const data = checker.getPropertyOfType(result, 'data');
    result = checker.getTypeOfSymbolAtLocation(data, data.valueDeclaration ?? data.declarations?.[0]);
  }
  return result;
}

function callbackParameterType(project, fn) {
  const { ts, checker } = project;
  for (const parameter of fn.parameters ?? []) {
    const type = checker.getTypeAtLocation(parameter);
    const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    const first = signature?.getParameters()[0];
    if (!first) continue;
    const messageType = checker.getTypeOfSymbolAtLocation(first, first.valueDeclaration ?? parameter);
    if (!(messageType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return messageType;
  }
  return undefined;
}

// A named interface, type alias, class, enum or JSDoc @typedef anywhere in the project.
export function findNamedType(project, name) {
  const { ts, checker } = project;
  for (const file of project.files) {
    const symbol = checker.getSymbolAtLocation(file);
    const candidates = [...(symbol ? checker.getExportsOfModule(symbol) : []), ...(file.locals ? [...file.locals.values()] : [])];
    for (const candidate of candidates) {
      if (candidate.name !== name) continue;
      const target = candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate;
      if (target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum | ts.SymbolFlags.TypeAlias)) {
        return { type: checker.getDeclaredTypeOfSymbol(target), file: path.relative(project.root, file.fileName) };
      }
    }
  }
  return null;
}

// Builds a value of `type`. Lists get `items` entries, objects get every data property (methods and
// getters are skipped), and recursion stops at `maxDepth`.
export function sampleType(project, type, { items = 3, now = new Date(), maxDepth = 7 } = {}) {
  const { ts, checker } = project;
  const stack = new Set();
  const visit = (current, ctx) => {
    const flags = current.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter)) return null;
    if (current.isStringLiteral?.()) return current.value;
    if (current.isNumberLiteral?.()) return current.value;
    if (flags & ts.TypeFlags.BooleanLiteral) return current.intrinsicName === 'true';
    if (flags & ts.TypeFlags.BigIntLiteral) return Number(current.value?.base10Value ?? 0);
    if (flags & ts.TypeFlags.Boolean) return booleanFor(ctx);
    if (current.isUnion?.()) {
      const options = current.types.filter((member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
      if (!options.length) return null;
      if (options.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)) return booleanFor(ctx);
      if (options.every((member) => member.isStringLiteral?.() || member.isNumberLiteral?.())) return options[ctx.index % options.length].value;
      const object = options.find((member) => member.flags & ts.TypeFlags.Object);
      return visit(object ?? options[0], ctx);
    }
    if (current.isIntersection?.()) return Object.assign({}, ...current.types.map((member) => visit(member, ctx)).filter((value) => value && typeof value === 'object'));
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) return stringFor(ctx);
    if (flags & (ts.TypeFlags.Number | ts.TypeFlags.BigInt)) return numberFor(ctx);
    if (flags & ts.TypeFlags.ESSymbolLike) return null;
    if (!(flags & ts.TypeFlags.Object) && !(flags & ts.TypeFlags.NonPrimitive)) return null;

    const symbolName = current.getSymbol?.()?.getName();
    if (symbolName === 'Date') return dateFor(ctx);
    if (isArray(project, current)) {
      if (ctx.depth >= maxDepth) return [];
      const [element] = checker.getTypeArguments(current);
      const owner = element ? displayName(project, element) : ctx.owner;
      return Array.from({ length: items }, (_, index) => visit(element, { ...ctx, index, inArray: true, owner, depth: ctx.depth + 1 }));
    }
    if (checker.isTupleType?.(current)) return checker.getTypeArguments(current).map((element, index) => visit(element, { ...ctx, index, depth: ctx.depth + 1 }));
    if (symbolName === 'Promise') return visit(checker.getAwaitedType(current) ?? current, ctx);
    if (symbolName === 'Map' || symbolName === 'Record' && !checker.getPropertiesOfType(current).length) return {};
    if (symbolName === 'Set') return [];
    const properties = checker.getPropertiesOfType(current).filter((symbol) => symbol.flags & ts.SymbolFlags.Property && !(symbol.flags & ts.SymbolFlags.Method));
    if (!properties.length) {
      if (checker.getSignaturesOfType(current, ts.SignatureKind.Call).length) return undefined;
      const index = checker.getIndexInfosOfType?.(current)?.[0];
      if (!index) return {};
      return Object.fromEntries([0, 1].map((i) => [`${ctx.key || 'key'}-${i + 1}`, visit(index.type, { ...ctx, index: i, depth: ctx.depth + 1 })]));
    }
    if (stack.has(current) || ctx.depth >= maxDepth) return null;
    stack.add(current);
    const owner = displayName(project, current);
    const out = {};
    for (const property of properties) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = checker.getTypeOfSymbol?.(property) ?? checker.getTypeOfSymbolAtLocation(property, declaration);
      if (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length && !checker.getPropertiesOfType(propertyType).length) continue;
      const value = visit(propertyType, { ...ctx, key: property.name, owner, depth: ctx.depth + 1 });
      if (value !== undefined) out[property.name] = value;
    }
    stack.delete(current);
    return out;
  };
  return visit(type, { key: '', owner: displayName(project, type), index: 0, depth: 0, items, now });
}

// Objects and lists look like API payloads; a bare string or number from an unrelated helper does not.
export function isDataType(project, type) {
  const { ts } = project;
  if (type.isUnion?.()) return type.types.some((member) => isDataType(project, member));
  return Boolean(type.flags & ts.TypeFlags.Object);
}

function isArray(project, type) {
  const { checker } = project;
  if (checker.isArrayType) return checker.isArrayType(type);
  const name = type.getSymbol?.()?.getName();
  return name === 'Array' || name === 'ReadonlyArray';
}

function displayName(project, type) {
  const symbol = type.aliasSymbol ?? type.getSymbol?.();
  const name = symbol?.getName();
  return name && !name.startsWith('__') ? name : project.checker.typeToString(type).replace(/[^A-Za-z]/g, ' ');
}

export function isDateLike(name) {
  return isDateName(name);
}
