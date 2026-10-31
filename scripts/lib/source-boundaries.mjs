import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
const networkModules =
  /^(?:node:)?(?:http|https|http2|net|tls|dns)$|^(?:ws|undici|openai|obs-websocket-js)$|^@openai\//;

/** Dependency hygiene only. Runtime isolation is enforced independently by the host. */
export function findSourceBoundaryErrors({ root, filePath, source, definitions }) {
  const owner = definitions.find(({ path }) => inside(resolve(root, path), filePath));
  if (!owner) return [];
  const errors = [];
  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  function check(specifier) {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      errors.push(`${filePath}: module imports must use a static string`);
      return;
    }
    const name = specifier.text;
    if (name.startsWith('.')) {
      if (!inside(resolve(root, owner.path), resolve(dirname(filePath), name)))
        errors.push(`${filePath}: cross-workspace relative import is not allowed`);
      return;
    }
    if (isAbsolute(name) || name.startsWith('file:'))
      errors.push(`${filePath}: absolute source imports are not allowed`);
    const internalName = name.split('/').slice(0, 2).join('/');
    if (name.startsWith('@riff/') && !owner.internalDependencies.includes(internalName))
      errors.push(`${filePath}: ${internalName} is not allowed`);
    if (owner.name === '@riff/sdk')
      errors.push(`${filePath}: SDK imports must remain dependency-free`);
    if (
      owner.path.startsWith('packages/') &&
      owner.name !== '@riff/twitch' &&
      networkModules.test(name)
    )
      errors.push(`${filePath}: network transports belong to the host`);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      check(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) check(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        errors.push(`${filePath}: use ESM imports instead of require`);
      if (
        owner.path.startsWith('packages/') &&
        owner.name !== '@riff/twitch' &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'fetch'
      )
        errors.push(`${filePath}: network transports belong to the host`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}
