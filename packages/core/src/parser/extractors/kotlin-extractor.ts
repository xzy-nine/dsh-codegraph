import Parser from 'web-tree-sitter';
import {
  CodeNode,
  CodeEdge,
  SemanticRole,
  LanguageExtractor,
  ExtractedFileResult,
  FileImportInfo,
  UnresolvedCall,
  UnresolvedInheritance,
} from '../../types/index.js';
import {
  formatNodeId,
  formatQualifiedName,
  formatScipUri,
  normalizeRoutePattern,
} from '../scip-utils.js';

/**
 * Kotlin 提取器 (Android / JVM / Kotlin Multiplatform)。
 *
 * 注意：本项目使用的 tree-sitter-kotlin 语法**没有具名字段 (named fields)**，
 * 所有结构都只能通过 `namedChildren` 的位置与节点类型判断 —— 这与 Java 语法
 * 可用 `childForFieldName('name')` 的写法完全不同。因此本文件统一使用
 * `firstChildOfType` / `childrenOfType` 这类按类型取子节点的辅助函数。
 */
export class KotlinExtractor implements LanguageExtractor {
  public readonly language = 'kotlin';
  public readonly fileExtensions = ['.kt'];
  public readonly wasmGrammarName = 'kotlin';

  public extractFile(tree: Parser.Tree, filePath: string, sourceCode: string): ExtractedFileResult {
    return extractKotlinFile(tree, filePath, sourceCode);
  }
}

/** 按类型取第一个直接子节点 */
function firstChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  for (const c of node.namedChildren) {
    if (c.type === type) return c;
  }
  return undefined;
}

/** 按类型取全部直接子节点 */
function childrenOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  return node.namedChildren.filter((c) => c.type === type);
}

/** 深度优先查找首个指定类型的后代节点 */
function findDescendant(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const c of node.namedChildren) {
    const hit = findDescendant(c, type);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 判断类声明的形态。Kotlin 把 interface / enum / annotation / data class
 * 全部解析成 `class_declaration`，只能靠关键字与子节点区分。
 */
function classifyClassDeclaration(node: Parser.SyntaxNode): {
  isInterface: boolean;
  isEnum: boolean;
  isAnnotation: boolean;
  isData: boolean;
  isSealed: boolean;
} {
  const head = node.text.slice(0, 80).replace(/\s+/g, ' ');
  const modifiers = firstChildOfType(node, 'modifiers');
  const modifierText = modifiers ? modifiers.text.toLowerCase() : '';
  return {
    isInterface: /^\s*(?:public|internal|private|protected|abstract|sealed|fun)?\s*interface\b/.test(head),
    isEnum: Boolean(firstChildOfType(node, 'enum_class_body')) || /\benum\s+class\b/.test(head),
    isAnnotation: /^\s*(?:public|internal|private)?\s*annotation\s+class\b/.test(head),
    isData: /\bdata\b/.test(modifierText) || /^\s*data\s+class\b/.test(head),
    isSealed: /\bsealed\b/.test(modifierText) || /^\s*sealed\s+class\b/.test(head),
  };
}

/**
 * 由类名与形态推断语义角色 (Android 惯例优先)。
 */
function inferClassRole(
  name: string,
  kind: { isInterface: boolean; isEnum: boolean; isData: boolean; isAnnotation: boolean }
): SemanticRole {
  if (kind.isInterface) return 'MODEL';
  if (kind.isEnum || kind.isData || kind.isAnnotation) return 'MODEL';
  if (/(Repository|Repo|Dao|DataSource|Store|Database|Entity)$/.test(name)) return 'REPOSITORY';
  if (/(ViewModel|UseCase|Interactor|Service|Manager|Controller|Presenter|Handler)$/.test(name)) return 'SERVICE';
  if (/(Activity|Fragment|Screen|Dialog|Widget|Adapter|Application)$/.test(name)) return 'ENTRY';
  if (/(Util|Utils|Helper|Extension|Ext|Constants?)$/.test(name)) return 'UTIL';
  if (/(Client|Api|ApiService|Network|Retrofit|Socket|Transport)$/.test(name)) return 'INFRA';
  return 'UNKNOWN';
}

/** 提取类声明上的注解文本 (Retrofit / Compose / Hilt 等)。 */
function collectAnnotations(node: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  const mods = firstChildOfType(node, 'modifiers');
  if (!mods) return out;
  for (const c of mods.namedChildren) {
    if (c.type === 'annotation') out.push(c.text);
  }
  // 函数/属性上的注解可能挂在函数节点自身
  for (const c of node.namedChildren) {
    if (c.type === 'annotation') out.push(c.text);
  }
  return out;
}

/**
 * 从 Retrofit 风格注解解析 HTTP 端点。
 * 支持 @GET("users/{id}") / @POST("...") / @PUT / @DELETE / @PATCH / @HTTP。
 */
function parseRetrofitRoute(annotations: string[]): {
  isEndpoint: boolean;
  method?: string;
  routePath?: string;
} {
  for (const ann of annotations) {
    const m = ann.match(
      /@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*(?:value\s*=\s*)?["']([^"']*)["']/i
    );
    if (m) {
      return { isEndpoint: true, method: m[1].toUpperCase(), routePath: m[2] || '' };
    }
    const http = ann.match(
      /@HTTP\s*\(\s*method\s*=\s*["']([A-Z]+)["']\s*,\s*(?:path|value)\s*=\s*["']([^"']*)["']/i
    );
    if (http) {
      return { isEndpoint: true, method: http[1].toUpperCase(), routePath: http[2] || '' };
    }
  }
  return { isEndpoint: false };
}

/**
 * 解析调用表达式，取出被调用的方法/函数名。
 *
 * Kotlin 语法里 `repo.findUser(id)` 的结构是：
 *   call_expression
 *     navigation_expression
 *       simple_identifier        -> "repo"      (接收者)
 *       navigation_suffix
 *         simple_identifier      -> "findUser"  (真正被调用的方法)
 *     call_suffix
 * 因此不能只取 navigation_expression 的直接 simple_identifier 子节点，
 * 必须深入 navigation_suffix 拿到最后一个标识符，否则会把接收者当成被调用方。
 */
function calleeNameOf(callNode: Parser.SyntaxNode): string | undefined {
  for (const c of callNode.namedChildren) {
    if (c.type === 'simple_identifier') return c.text;

    if (c.type === 'navigation_expression') {
      // 优先取 navigation_suffix 里的方法名
      const suffixes = childrenOfType(c, 'navigation_suffix');
      for (let i = suffixes.length - 1; i >= 0; i--) {
        const ids = collectIdentifiers(suffixes[i]);
        if (ids.length > 0) return ids[ids.length - 1];
      }
      // 退化：取整段里最后一个标识符 (链式调用 a.b.c 之类)
      const all = collectIdentifiers(c);
      if (all.length > 0) return all[all.length - 1];
    }

    // 链式调用 a.b().c()：内层 call_expression
    if (c.type === 'call_expression') {
      const inner = calleeNameOf(c);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** 按源码顺序收集子树中的全部 simple_identifier。 */
function collectIdentifiers(node: Parser.SyntaxNode, out: string[] = []): string[] {
  if (node.type === 'simple_identifier') {
    out.push(node.text);
    return out;
  }
  for (const c of node.namedChildren) collectIdentifiers(c, out);
  return out;
}

/**
 * 深度解析 Kotlin 源码，提取 package、import、类/接口/对象/枚举、
 * 函数/方法、继承实现关系、函数调用以及 Retrofit HTTP 端点。
 */
export function extractKotlinFile(
  tree: Parser.Tree,
  filePath: string,
  sourceCode: string
): ExtractedFileResult {
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const imports: FileImportInfo[] = [];
  const unresolvedCalls: UnresolvedCall[] = [];
  const unresolvedInheritance: UnresolvedInheritance[] = [];

  let packageName = '';

  // 1. 文件节点
  const fileNodeId = formatNodeId(filePath, 'file');
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  nodes.push({
    id: fileNodeId,
    name: fileName,
    qualifiedName: formatQualifiedName(filePath, 'file'),
    entityType: 'FILE',
    semanticRole: 'UNKNOWN',
    filePath,
    language: 'kotlin',
    scipUri: formatScipUri('kotlin', filePath, '', fileName, 'def'),
    loc: {
      startLine: tree.rootNode.startPosition.row + 1,
      endLine: tree.rootNode.endPosition.row + 1,
    },
  });

  const contextStack: CodeNode[] = [];

  function getCurrentCaller(): CodeNode | undefined {
    for (let i = contextStack.length - 1; i >= 0; i--) {
      const n = contextStack[i];
      if (n.entityType === 'FUNCTION' || n.entityType === 'METHOD' || n.entityType === 'ENDPOINT') {
        return n;
      }
    }
    return undefined;
  }

  function traverse(node: Parser.SyntaxNode) {
    const type = node.type;

    // package 声明: package_header -> identifier
    if (type === 'package_header') {
      const id = findDescendant(node, 'identifier');
      if (id) packageName = id.text.trim();
      return;
    }

    // import 声明: import_header -> identifier [+ import_alias]
    if (type === 'import_header') {
      const id = findDescendant(node, 'identifier');
      if (id) {
        const fullPath = id.text.trim();
        const shortName = fullPath.split('.').pop() || fullPath;
        const aliasNode = firstChildOfType(node, 'import_alias');
        const alias = aliasNode ? aliasNode.text.replace(/^as\s+/i, '').trim() : undefined;
        imports.push({
          modulePath: fullPath,
          importedNames: [{ name: shortName, ...(alias ? { alias } : {}) }],
          isFromImport: true,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    // 类 / 接口 / 枚举 / 注解类 / data class
    if (type === 'class_declaration') {
      const nameNode = firstChildOfType(node, 'type_identifier');
      const className = nameNode ? nameNode.text : 'AnonymousClass';
      const kind = classifyClassDeclaration(node);
      const annotations = collectAnnotations(node);

      const semanticRole = inferClassRole(className, kind);

      const nodeId = formatNodeId(filePath, className);
      const qName = packageName ? `${packageName}.${className}` : className;
      const entityType = kind.isInterface ? 'INTERFACE' : 'CLASS';

      const classNode: CodeNode = {
        id: nodeId,
        name: className,
        qualifiedName: qName,
        entityType,
        semanticRole,
        filePath,
        language: 'kotlin',
        scipUri: formatScipUri('kotlin', filePath, packageName, className, kind.isInterface ? 'interface' : 'class'),
        loc: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        },
        metadata: {
          annotations,
          isData: kind.isData,
          isEnum: kind.isEnum,
          isSealed: kind.isSealed,
        },
      };
      nodes.push(classNode);
      edges.push({
        id: `contains_${fileNodeId}_${nodeId}`,
        source: fileNodeId,
        target: nodeId,
        relation: 'CONTAINS',
        confidence: 'EXTRACTED',
      });

      // 继承与接口实现: delegation_specifier
      //   constructor_invocation -> 继承的父类 (class Foo : Bar())
      //   user_type              -> 实现的接口 (class Foo : Baz)
      for (const spec of childrenOfType(node, 'delegation_specifier')) {
        const ctorInvocation = firstChildOfType(spec, 'constructor_invocation');
        const userType = firstChildOfType(spec, 'user_type');
        const target = ctorInvocation
          ? firstChildOfType(ctorInvocation, 'user_type') || ctorInvocation
          : userType;
        if (target) {
          const superName = (firstChildOfType(target, 'type_identifier') || target).text.trim();
          if (superName) {
            unresolvedInheritance.push({
              classNodeId: nodeId,
              superclassName: superName,
              line: spec.startPosition.row + 1,
            });
          }
        }
      }

      contextStack.push(classNode);
      const body = firstChildOfType(node, 'class_body') || firstChildOfType(node, 'enum_class_body');
      if (body) {
        for (const child of body.namedChildren) traverse(child);
      }
      contextStack.pop();
      return;
    }

    // object 声明 (单例 / companion object)
    if (type === 'object_declaration') {
      const nameNode = firstChildOfType(node, 'type_identifier');
      const objName = nameNode ? nameNode.text : 'Companion';
      const nodeId = formatNodeId(filePath, objName);
      const qName = packageName ? `${packageName}.${objName}` : objName;

      const objNode: CodeNode = {
        id: nodeId,
        name: objName,
        qualifiedName: qName,
        entityType: 'CLASS',
        semanticRole: /(Module|Component|Provider|Factory)$/.test(objName) ? 'INFRA' : 'UNKNOWN',
        filePath,
        language: 'kotlin',
        scipUri: formatScipUri('kotlin', filePath, packageName, objName, 'class'),
        loc: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        },
        metadata: { isObject: true },
      };
      nodes.push(objNode);
      edges.push({
        id: `contains_${fileNodeId}_${nodeId}`,
        source: fileNodeId,
        target: nodeId,
        relation: 'CONTAINS',
        confidence: 'EXTRACTED',
      });

      contextStack.push(objNode);
      const body = firstChildOfType(node, 'class_body');
      if (body) {
        for (const child of body.namedChildren) traverse(child);
      }
      contextStack.pop();
      return;
    }

    // 函数 / 方法
    if (type === 'function_declaration') {
      const nameNode = firstChildOfType(node, 'simple_identifier');
      const fnName = nameNode ? nameNode.text : 'anonymous_function';
      const parent = contextStack[contextStack.length - 1];
      const annotations = collectAnnotations(node);

      const routeInfo = parseRetrofitRoute(annotations);
      const isEndpoint = routeInfo.isEndpoint;
      // 顶层函数 (无父容器) 归为 FUNCTION，类内归为 METHOD
      const isTopLevel = !parent || parent.entityType === 'FILE';

      const nodeId = formatNodeId(
        filePath,
        parent && !isTopLevel ? `${parent.name}_${fnName}` : fnName
      );
      const qName = parent && !isTopLevel ? `${parent.qualifiedName}.${fnName}` : packageName ? `${packageName}.${fnName}` : fnName;

      const fnNode: CodeNode = {
        id: nodeId,
        name: fnName,
        qualifiedName: qName,
        entityType: isEndpoint ? 'ENDPOINT' : isTopLevel ? 'FUNCTION' : 'METHOD',
        semanticRole: isEndpoint
          ? 'ENTRY'
          : /^(on[A-Z]|setOn|bind|render|compose)/.test(fnName)
          ? 'ENTRY'
          : 'UNKNOWN',
        filePath,
        language: 'kotlin',
        scipUri: formatScipUri(
          'kotlin',
          filePath,
          parent ? `${packageName}#${parent.name}` : packageName,
          fnName,
          'method'
        ),
        loc: {
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        },
        metadata: annotations.length ? { annotations } : undefined,
      };

      if (isEndpoint && routeInfo.method) {
        fnNode.endpointMeta = {
          httpMethod: routeInfo.method,
          routePath: normalizeRoutePattern(routeInfo.routePath || ''),
          isClientCall: true,
        };
      }

      nodes.push(fnNode);
      edges.push({
        id: `contains_${parent ? parent.id : fileNodeId}_${nodeId}`,
        source: parent ? parent.id : fileNodeId,
        target: nodeId,
        relation: 'CONTAINS',
        confidence: 'EXTRACTED',
      });

      contextStack.push(fnNode);
      const body = firstChildOfType(node, 'function_body');
      if (body) {
        for (const child of body.namedChildren) traverse(child);
      }
      contextStack.pop();
      return;
    }

    // 调用表达式
    if (type === 'call_expression') {
      const caller = getCurrentCaller() || nodes[0];
      const callee = calleeNameOf(node);
      if (callee) {
        let apiCallMeta: { httpMethod?: string; routePattern?: string } | undefined;
        // OkHttp / Retrofit 客户端调用里的 URL 字面量
        const urlMatch = node.text.match(/["'](https?:\/\/[^"']+|\/[A-Za-z0-9_\-/{}.]+)["']/);
        if (urlMatch) {
          const pathOnly = urlMatch[1].match(/^(?:https?:\/\/[^/]+)?(\/[^?#"']*)/);
          if (pathOnly) {
            apiCallMeta = { routePattern: normalizeRoutePattern(pathOnly[1]) };
          }
        }
        unresolvedCalls.push({
          callerNodeId: caller.id,
          calleeExpression: callee,
          line: node.startPosition.row + 1,
          apiCallMeta,
        });
      }
      // 继续下钻，捕获嵌套调用
    }

    for (const child of node.namedChildren) traverse(child);
  }

  traverse(tree.rootNode);

  return {
    filePath,
    language: 'kotlin',
    nodes,
    edges,
    imports,
    unresolvedCalls,
    unresolvedInheritance,
  };
}
