import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { CodeGraphCore, CodeGraphServer } from '@codegraph/core';

export const name = 'dsh-codegraph';

export const inject = [];

export interface AdapterConfig {
  port?: number;
  workspaceRoot?: string;
  scopePath?: string;
}

export function apply(ctx: any, config: AdapterConfig = {}) {
  const port = config.port || 3333;
  let serverInstance: CodeGraphServer | null = null;
  let coreInstance: CodeGraphCore | null = null;

  /**
   * 获取当前活跃工作区根目录。
   *
   * 注意：cordis 不保证兄弟插件的挂载顺序，apply() 执行时
   * `ctx.workspaceRegistry` 很可能**还没挂载**。此时若直接回退到
   * process.cwd()，服务端会把工作区锁定成 DSH 的 profile 目录
   * (如 C:\Users\...\.dsh\profiles\desktop)，表现为
   * /api/status 返回 projects: 0、前端探测不到任何工程。
   *
   * 因此这里做两件事：
   *   1. 依次尝试多个可能的服务名/形态；
   *   2. 明确识别并排除 profile / 用户主目录这类"非工作区"路径，
   *      宁可返回 undefined，交由前端通过 ?workspace= 或
   *      /api/workspace 显式指定，也不要把 profile 目录当成项目根。
   */
  const isNonWorkspacePath = (p: string): boolean => {
    if (!p) return true;
    const norm = p.replace(/\\/g, '/').toLowerCase();
    // DSH 自身的数据目录 / profile 目录 / 用户主目录都不是代码工作区
    if (/\/\.dsh(\/|$)/.test(norm)) return true;
    if (/\/\.dsh\/profiles\//.test(norm)) return true;
    if (/^[a-z]:\/users\/[^/]+$/.test(norm)) return true;
    if (/^\/(users|home)\/[^/]+$/.test(norm)) return true;
    return false;
  };

  const detectWorkspaceRoot = (): string | undefined => {
    const candidates: Array<() => unknown> = [
      () => (ctx as any).workspaceRegistry?.list?.(),
      () => (ctx as any).workspace?.list?.(),
      () => (ctx as any).workspaces?.list?.(),
      () => {
        const svc = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
        return svc?.list?.();
      },
      () => {
        const svc = typeof ctx.get === 'function' ? ctx.get('workspace') : undefined;
        return svc?.list?.();
      },
    ];

    for (const attempt of candidates) {
      try {
        const list = attempt() as any;
        const items: any[] = Array.isArray(list)
          ? list
          : Array.isArray(list?.items)
          ? list.items
          : [];
        for (const item of items) {
          const p = typeof item === 'string' ? item : item?.path || item?.root;
          if (typeof p === 'string' && p.trim() && !isNonWorkspacePath(p)) {
            return p;
          }
        }
      } catch {
        /* 尝试下一个来源 */
      }
    }

    // 单值形态
    try {
      const direct =
        (ctx as any).workspace?.root ||
        (ctx as any).workspace?.getPath?.() ||
        (typeof ctx.get === 'function' ? (ctx.get('workspace') as any)?.root : undefined);
      if (typeof direct === 'string' && direct.trim() && !isNonWorkspacePath(direct)) {
        return direct;
      }
    } catch {}

    // 兜底：cwd 只有在看起来像代码工作区时才采用
    const cwd = process.cwd();
    if (!isNonWorkspacePath(cwd)) return cwd;

    return undefined;
  };

  const detectedRoot = detectWorkspaceRoot();
  const currentRoot = config.workspaceRoot || detectedRoot;

  // 1. 初始化并托管本地 CodeGraph 核心服务
  try {
    // 动态探测 Webview 静态资源目录 (支持独立插件部署与 monorepo 开发)
    let staticDir: string | undefined;
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const candidates = [
        path.resolve(__dirname, 'webview'),
        path.resolve(__dirname, '../webview'),
        path.resolve(__dirname, '../../webview/dist'),
        path.resolve(__dirname, '../packages/webview/dist'),
      ];
      for (const dir of candidates) {
        if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) {
          staticDir = dir;
          break;
        }
      }
    } catch {}

    // 未探测到工作区时，用一个中性占位目录启动服务；
    // 真正的分析目标由前端通过 ?workspace= / /api/workspace 指定。
    const bootRoot = currentRoot || os.tmpdir();

    serverInstance = new CodeGraphServer({
      workspaceRoot: bootRoot,
      port,
      scopePath: config.scopePath || '.',
      staticDir,
    });

    serverInstance.start().then(() => {
      console.log(`[CodeGraph] 适配器已成功挂载，交互视窗: http://127.0.0.1:${port}`);
      if (currentRoot) {
        console.log(`[CodeGraph] 初始工作区: ${currentRoot}`);
      } else {
        console.log('[CodeGraph] 未在启动时探测到工作区，等待前端指定目标工程');
      }
    }).catch((err) => {
      console.warn(`[CodeGraph] 服务启动警告:`, err.message);
    });

    // 创建直接供 Agent 调用的图谱引擎实例
    coreInstance = new CodeGraphCore({
      workspaceRoot: bootRoot,
      scopePath: config.scopePath || '.',
    });
  } catch (err: any) {
    console.error(`[CodeGraph] 初始化服务失败:`, err);
  }

  // 2. 宿主生命周期销毁注销
  ctx.on('dispose', async () => {
    if (serverInstance) {
      try {
        await serverInstance.stop();
        console.log(`[CodeGraph] 服务已停止`);
      } catch {}
      serverInstance = null;
    }
  });

  // 3. 注册 DeepSeek Agent 专属的低 Token 图谱查询工具 (若宿主开启了 tools 服务)
  const registerToolsOn = (toolsService: any) => {
    try {
      toolsService.register({
        name: 'query_code_graph',
        description: '使用 0-Token 本地 AST 语义引擎查询项目的架构宏观模块、调用拓扑总线或时序业务流程',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['summary', 'modules', 'flows', 'search_symbol'],
            description: '查询操作：summary (架构概要), modules (模块与端口), flows (业务时序链), search_symbol (符号定义与关联)',
          },
          query: {
            type: 'string',
            description: '针对 search_symbol 或 flows 的指定搜索词 (如函数名、模块名)',
          },
          workspaceRoot: {
            type: 'string',
            description: '可选：指定需要分析的项目根目录完整路径 (默认分析当前活动工作区)',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: any, value: string) => [{ type: 'text', text: value }],
        },
        async execute(args: { action: string; query?: string; workspaceRoot?: string }) {
          if (!coreInstance) {
            return JSON.stringify({ error: 'CodeGraphCore 尚未初始化' });
          }

          if (args.workspaceRoot) {
            coreInstance.setWorkspaceRoot(args.workspaceRoot);
          }

          // 若图谱尚未构建，先尝试从本地工程缓存恢复；若无缓存再执行全量扫描
          let result = coreInstance.getLastResult();
          if (!result && !args.workspaceRoot) {
            const cached = coreInstance.loadFromCache();
            if (cached) {
              result = cached.graph;
            }
          }
          if (!result || args.workspaceRoot) {
            result = await coreInstance.scan();
          }

          switch (args.action) {
            case 'summary':
              return JSON.stringify({
                projectName: result.meta.projectName,
                archetype: result.meta.archetype,
                healthScore: result.meta.archetypeHealth?.score,
                isAutoCorrected: result.meta.isAutoCorrected,
                fileCount: result.meta.fileCount,
                nodeCount: result.meta.nodeCount,
                edgeCount: result.meta.edgeCount,
                moduleCount: result.architectureView.modules.length,
                flowCount: result.processFlows.length,
              });

            case 'modules':
              return JSON.stringify(
                result.architectureView.modules.map((m) => ({
                  id: m.id,
                  name: m.name,
                  inPorts: m.inPorts,
                  outPorts: m.outPorts,
                  fileCount: m.files.length,
                }))
              );

            case 'flows': {
              let flows = result.processFlows;
              if (args.query) {
                const q = args.query.toLowerCase();
                flows = flows.filter((f) => f.title.toLowerCase().includes(q) || f.flowId.toLowerCase().includes(q));
              }
              return JSON.stringify(
                flows.map((f) => ({
                  id: f.flowId,
                  title: f.title,
                  chain: f.steps.map((s) => `[${s.stepType}] ${s.name} (${s.filePath}:${s.line})`).join(' -> '),
                }))
              );
            }

            case 'search_symbol': {
              if (!args.query) {
                return JSON.stringify({ error: '缺少 query 参数' });
              }
              const q = args.query.toLowerCase();
              const matched = Object.values(result.allNodes).filter(
                (n) => n.name.toLowerCase().includes(q) || n.qualifiedName.toLowerCase().includes(q)
              );
              return JSON.stringify(
                matched.slice(0, 10).map((n) => ({
                  name: n.name,
                  qualifiedName: n.qualifiedName,
                  role: n.semanticRole,
                  file: n.filePath,
                  line: n.loc.startLine,
                  signature: n.signature,
                }))
              );
            }

            default:
              return JSON.stringify({ error: `未知 action: ${args.action}` });
          }
        },
      });
      console.log('[CodeGraph] Agent 工具 query_code_graph 已成功注册');
    } catch (e: any) {
      console.warn('[CodeGraph] 注册 Agent 工具警告:', e.message);
    }
  };

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    registerToolsOn(ctx.tools);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope: any) => {
      if (scope.tools && typeof scope.tools.register === 'function') {
        registerToolsOn(scope.tools);
      }
    });
  }
}
