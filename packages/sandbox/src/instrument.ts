import ts from 'typescript';

/** Observe every call result, including detached async calls, without changing
 * method receivers or evaluation order. Reserved bindings cannot be shadowed.
 * Example: instrumentHandler('(e, r) => r.util.now()'). */
export function instrumentHandler(source: string): string {
  let reserved = false;
  const original = ts.createSourceFile(
    'handler.js',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  function check(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text.startsWith('__riff')) reserved = true;
    ts.forEachChild(node, check);
  }
  check(original);
  // The artifact must be exactly one function expression; reject statement smuggling
  // such as `x => x); other(` that would run code outside the handler.
  const wrapped = ts.createSourceFile(
    'wrapped.js',
    `(${source})`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const only = wrapped.statements.length === 1 ? wrapped.statements[0] : undefined;
  const inner =
    only && ts.isExpressionStatement(only) && ts.isParenthesizedExpression(only.expression)
      ? only.expression.expression
      : undefined;
  if (
    !inner ||
    !(ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isCallExpression(inner))
  )
    throw new Error('Handler must be a single function expression');
  const result = ts.transpileModule(`const __riffHandler = (${source});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
    transformers: {
      before: [
        (context) => (root) => {
          const visit: ts.Visitor = (node) => {
            const next = ts.visitEachChild(node, visit, context);
            if (
              (ts.isArrowFunction(next) ||
                ts.isFunctionExpression(next) ||
                ts.isFunctionDeclaration(next) ||
                ts.isMethodDeclaration(next)) &&
              next.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
              next.body
            ) {
              const body = next.body;
              const statements = ts.isBlock(body)
                ? body.statements
                : [ts.factory.createReturnStatement(body)];
              const guarded = ts.factory.createBlock(
                [
                  ts.factory.createTryStatement(
                    ts.factory.createBlock(statements, true),
                    ts.factory.createCatchClause(
                      ts.factory.createVariableDeclaration('__riffError'),
                      ts.factory.createBlock(
                        [
                          ts.factory.createExpressionStatement(
                            ts.factory.createCallExpression(
                              ts.factory.createIdentifier('__riffFault'),
                              undefined,
                              [],
                            ),
                          ),
                          ts.factory.createThrowStatement(
                            ts.factory.createIdentifier('__riffError'),
                          ),
                        ],
                        true,
                      ),
                    ),
                    undefined,
                  ),
                ],
                true,
              );
              return ts.visitEachChild(
                next,
                (child) => (child === body ? guarded : child),
                context,
              );
            }
            if (ts.isCallExpression(next) || ts.isNewExpression(next))
              return ts.factory.createCallExpression(
                ts.factory.createIdentifier('__riffObserve'),
                undefined,
                [next],
              );
            return next;
          };
          return ts.visitNode(root, visit) as ts.SourceFile;
        },
      ],
    },
  });
  if (reserved || result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error))
    throw new Error('Invalid handler or reserved execution binding');
  return `${result.outputText}\n__riffHandler(event, riff)`;
}
