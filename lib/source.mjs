import path from 'node:path';
import ts from 'typescript';

export const isSource = file => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file);
export const isTest = file => /(?:^|\/)(?:__tests__|tests?|__mocks__)(?:\/|$)|\.(?:spec|test)\.[^.]+$/i.test(file);
export const portable = file => file.split(path.sep).join('/');
export const ignoredDirectories = Object.freeze([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo'
]);
export const isGenerated = file => file.split('/').some(part => ignoredDirectories.includes(part));

export function lineOf(node, source) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function declarations(source) {
  const found = [];
  function visit(node, owner) {
    const container = ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
      ts.isModuleDeclaration(node) || ts.isClassExpression(node);
    let name;
    let kind;
    let body;
    let header = node;
    if (container || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      name = node.name?.getText(source) ?? 'default';
      kind = ts.SyntaxKind[node.kind].replace(/Declaration|Expression/, '').toLowerCase();
    } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      name = node.name?.getText(source) ?? (ts.isConstructorDeclaration(node) ? 'constructor' : 'default');
      if (ts.isGetAccessorDeclaration(node)) name = 'get ' + name;
      if (ts.isSetAccessorDeclaration(node)) name = 'set ' + name;
      kind = ts.isFunctionDeclaration(node) ? 'function' : 'method';
      body = node.body;
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      name = node.name.getText(source);
      const initializer = node.initializer;
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        kind = ts.isVariableDeclaration(node) ? 'function' : 'method';
        body = initializer.body;
      } else {
        kind = ts.isVariableDeclaration(node) ? 'variable' : 'property';
        body = initializer;
      }
      if (ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent)) {
        header = node.parent.parent;
      }
    }
    if (name && kind) {
      const qualified = owner ? owner + '.' + name : name;
      found.push({ name: qualified, kind, node, header, body, container, line: lineOf(node, source) });
      owner = qualified;
    }
    // Keep the graph at module and class scope. Calls inside callbacks belong
    // to the enclosing declaration.
    if (node === source || container || ts.isModuleBlock(node) ||
        ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) {
      ts.forEachChild(node, child => visit(child, owner));
    }
  }
  visit(source, '');
  return found;
}
