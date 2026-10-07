import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { FullGraphResult, ArchetypeType } from './types/index.js';
import { getParserForLanguage } from './parser/tree-sitter-loader.js';
import { ExtractorRegistry } from './parser/extractor-registry.js';
import { SymbolTable } from './indexer/symbol-table.js';
import { DualTrackWatcher } from './watcher/hash-watcher.js';
import { ArchetypeEngine } from './archetype/detector.js';
import { DualModelCompiler } from './graph/dual-compiler.js';
import {
  PersistentCacheData,
  saveCache,
  loadCache,
  hasCache,
} from './persistence/cache-store.js';

export * from './types/index.js';
export * from './parser/tree-sitter-loader.js';
export * from './parser/scip-utils.js';
export * from './parser/extractor-registry.js';
export * from './parser/extractors/python-extractor.js';
export * from './parser/extractors/typescript-extractor.js';
export * from './parser/extractors/go-extractor.js';
export * from './parser/extractors/java-extractor.js';
export * from './parser/extractors/rust-extractor.js';
export * from './parser/extractors/cpp-extractor.js';
export * from './parser/extractors/csharp-extractor.js';
export * from './parser/extractors/kotlin-extractor.js';
export * from './graph/contract-linker.js';
export * from './indexer/symbol-table.js';
export * from './watcher/hash-watcher.js';
export * from './archetype/detector.js';
export * from './archetype/workspace-profiler.js';
export * from './graph/dual-compiler.js';
export * from './graph/interaction-narrator.js';
export * from './layout/elk-layout.js';
export * from './persistence/cache-store.js';
export * from './server.js';
import { WorkspaceProfiler } from './archetype/workspace-profiler.js';
import { DetectedProjectProfile, WorkspaceDiscoveryResult, ScanProgress, ScanStage } from './types/index.js';

export interface CodeGraphCoreOptions {
  workspaceRoot: string;
  scopePath?: string;
  forceArchetype?: ArchetypeType;
}

export class CodeGraphCore {
  private workspaceRoot: string;
  private scopePath: string;
  private symbolTable: SymbolTable;
  private watcher: DualTrackWatcher;
  private lastGraphResult?: FullGraphResult;
  private lastLayout?: { architecture?: any; drilldowns?: Record<string, { layout: any; portEdges: any[]; version?: string }> };
  private forceArchetype?: ArchetypeType;
  private projects: DetectedProjectProfile[] = [];
  private selectedProjectIds: string[] = [];
  private activeProjectId?: string;
  /** 当前扫描进度快照 (供 /api/progress 轮询)。 */
  private progress: ScanProgress = CodeGraphCore.idleProgress();

  private static idleProgress(): ScanProgress {
    const now = Date.now();
    return {
      stage: 'idle',
      message: '待命中',
      current: 0,
      total: 0,
      percent: 0,
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      logs: [],
    };
  }

  /**
   * 更新并广播扫描进度。各阶段权重经过实测标定：AST 解析占绝大部分时间，
   * 因此 0–70% 给解析，其余阶段共享 70–100%，保证进度条不会长时间卡住。
   */
  private reportProgress(
    stage: ScanStage,
    message: string,
    current: number,
    total: number,
    percent: number,
    extra?: { etaMs?: number; log?: string }
  ): void {
    const now = Date.now();
    const logs = this.progress.logs ? [...this.progress.logs] : [];
    if (extra?.log) {
      logs.push(extra.log);
      // 只保留最近 40 条，避免无限增长
      if (logs.length > 40) logs.splice(0, logs.length - 40);
    }
    this.progress = {
      stage,
      message,
      current,
      total,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      startedAt: this.progress.startedAt,
      updatedAt: now,
      elapsedMs: now - this.progress.startedAt,
      etaMs: extra?.etaMs,
      logs,
      error: stage === 'error' ? message : undefined,
    };
  }

  /** 读取当前扫描进度快照。 */
  public getProgress(): ScanProgress {
    return { ...this.progress, elapsedMs: Date.now() - this.progress.startedAt };
  }

  /** 由 server 层在扫描收尾阶段 (布局/落盘) 推进进度。 */
  public reportStage(stage: ScanStage, message: string, percent: number): void {
    this.reportProgress(stage, message, this.progress.current, this.progress.total, percent);
  }

  /** 扫描失败时记录错误，供前端进度面板展示。 */
  public reportFailure(message: string): void {
    this.reportProgress('error', message, this.progress.current, this.progress.total, this.progress.percent);
  }

  /**
   * 让出事件循环。
   *
   * tree-sitter 的 `parser.parse()` 是**同步 CPU 密集**调用，整个解析循环会把
   * Node 事件循环彻底占死 —— 实测在数千文件的工作区上，HTTP 服务在此期间
   * 完全无法响应，连 /api/progress 都超时，进度条永远停在 0%。
   * 因此每解析若干文件就 await 一次 setImmediate，把控制权交还事件循环，
   * 让进度轮询请求有机会被处理。
   */
  private static yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  constructor(options: CodeGraphCoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.scopePath = options.scopePath || '.';
    this.symbolTable = new SymbolTable();
    this.watcher = new DualTrackWatcher(this.workspaceRoot, this.scopePath);
    this.forceArchetype = options.forceArchetype;
  }

  /**
   * 动态切换/更新工作区根目录与扫描作用域
   */
  public setWorkspaceRoot(newRoot: string, newScope: string = '.'): void {
    const resolvedRoot = path.resolve(newRoot);
    if (this.workspaceRoot !== resolvedRoot || this.scopePath !== newScope) {
      this.workspaceRoot = resolvedRoot;
      this.scopePath = newScope || '.';
      this.symbolTable = new SymbolTable();
      this.watcher = new DualTrackWatcher(this.workspaceRoot, this.scopePath);
      this.lastGraphResult = undefined;
      this.lastLayout = undefined;
      // 工作区变了，旧的工程画像与勾选不再适用；否则切换工程会拿旧列表
      // 去匹配新工作区的文件，导致模块分组错乱。
      this.projects = [];
      this.selectedProjectIds = [];
      this.activeProjectId = undefined;
    }
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public getScopePath(): string {
    return this.scopePath;
  }

  /**
   * 动态设置/更新扫描的作用域子目录
   */
  public setScopePath(newScope: string): void {
    this.scopePath = newScope || '.';
    this.watcher = new DualTrackWatcher(this.workspaceRoot, this.scopePath);
  }

  public discoverProjects(): WorkspaceDiscoveryResult {
    return WorkspaceProfiler.discover(this.workspaceRoot);
  }

  public getProjects(): DetectedProjectProfile[] {
    return this.projects;
  }

  public getSelectedProjectIds(): string[] {
    return this.selectedProjectIds;
  }

  public setSelectedProjectIds(ids: string[]): void {
    this.selectedProjectIds = ids;
  }

  public getActiveProjectId(): string | undefined {
    return this.activeProjectId;
  }

  /**
   * 极速内存切换单工程精细视图与全生态总览 (无须重新解析文件 AST，< 15ms)
   */
  public switchActiveProject(projectId?: string): FullGraphResult | undefined {
    this.activeProjectId = projectId && projectId !== 'all' ? projectId : undefined;
    if (!this.lastGraphResult) return undefined;

    const allFiles = Array.from(
      new Set(
        this.symbolTable
          .getAllNodes()
          .map((n) => n.filePath)
          .filter((f) => !f.startsWith('contracts/'))
      )
    );

    const projectName = path.basename(this.workspaceRoot);
    const activeProjects = this.projects.filter((p) => this.selectedProjectIds.includes(p.id));

    const result = DualModelCompiler.compile(
      projectName,
      this.scopePath,
      allFiles,
      this.symbolTable.getAllNodes(),
      this.symbolTable.getAllEdges(),
      this.lastGraphResult.meta.archetype || 'UNIVERSAL',
      {
        projects: activeProjects.length > 0 ? activeProjects : this.projects,
        activeProjectId: this.activeProjectId,
      }
    );

    this.lastGraphResult = result;
    return result;
  }

  private getFileProjectId(filePath: string): string | undefined {
    if (this.projects.length === 0) return undefined;
    if (this.projects.length === 1 && this.projects[0].relPath === '.') {
      return this.projects[0].id;
    }
    const sorted = [...this.projects].sort((a, b) => b.relPath.length - a.relPath.length);
    for (const p of sorted) {
      if (p.relPath === '.' || filePath === p.relPath || filePath.startsWith(p.relPath + '/')) {
        return p.id;
      }
    }
    return undefined;
  }

  /**
   * 执行跨语言多语法全量代码解析与双模型图谱编译 (0-Token 本地运行)
   */
  public async scan(
    forceFull: boolean = false,
    options?: { selectedProjectIds?: string[]; activeProjectId?: string }
  ): Promise<FullGraphResult> {
    const startTime = Date.now();
    // 重置进度计时基准
    this.progress = { ...CodeGraphCore.idleProgress(), startedAt: startTime, updatedAt: startTime };

    // 0. 系统关键目录与磁盘根硬拦截
    const danger = WorkspaceProfiler.checkDangerousRoot(this.workspaceRoot);
    if (danger.isDangerous) {
      this.reportProgress('error', danger.reason || '所选路径属于系统保护目录，拒绝扫描', 0, 0, 0);
      throw new Error(danger.reason || '所选路径属于操作系统保护目录或磁盘根目录，拒绝扫描');
    }

    // 0.1 嗅探多端/多工程画像
    this.reportProgress('discovering', '正在嗅探多端与多工程结构…', 0, 0, 2);
    const discovery = WorkspaceProfiler.discover(this.workspaceRoot);
    this.projects = discovery.projects;
    this.reportProgress(
      'discovering',
      `识别到 ${this.projects.length} 个工程`,
      this.projects.length,
      this.projects.length,
      6,
      { log: `工程嗅探完成：${this.projects.map((p) => p.name).join(', ') || '单工程'}` }
    );

    if (options?.selectedProjectIds && options.selectedProjectIds.length > 0) {
      this.selectedProjectIds = options.selectedProjectIds;
    } else {
      const recommended = this.projects.filter((p) => p.isRecommended).map((p) => p.id);
      this.selectedProjectIds = recommended.length > 0 ? recommended : this.projects.map((p) => p.id);
    }

    if (options?.activeProjectId !== undefined) {
      this.activeProjectId = options.activeProjectId && options.activeProjectId !== 'all' ? options.activeProjectId : undefined;
    }

    const searchRoot = path.resolve(this.workspaceRoot, this.scopePath);
    const globPatterns = ExtractorRegistry.getGlobPatterns();

    // 1. 扫描匹配多语言源码文件 (Python, TS, JS, Go, Java, Rust, C/C++, C#)
    const sourceFiles = await fg(globPatterns, {
      cwd: searchRoot,
      absolute: false,
      caseSensitiveMatch: false,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/venv/**',
        '**/.venv/**',
        '**/__pycache__/**',
        '**/dist/**',
        '**/build/**',
        '**/target/**',
        '**/bin/**',
        '**/obj/**',
        '**/out/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/.vs/**',
        '**/.idea/**',
        '**/.vscode/**',
      ],
    });

    // 规范化文件相对路径 (相对于 workspaceRoot)
    let normalizedFiles = sourceFiles.map((f) =>
      path.relative(this.workspaceRoot, path.join(searchRoot, f)).replace(/\\/g, '/')
    );

    // 过滤只包含被用户勾选/推荐的工程源码
    if (this.projects.length > 1 && this.selectedProjectIds.length > 0) {
      normalizedFiles = normalizedFiles.filter((f) => {
        const pid = this.getFileProjectId(f);
        return !pid || this.selectedProjectIds.includes(pid);
      });
    }

    // 2. 建立哈希基准
    this.reportProgress(
      'hashing',
      `已发现 ${normalizedFiles.length} 个源码文件，正在建立哈希基准…`,
      0,
      normalizedFiles.length,
      10,
      { log: `源码扫描：命中 ${normalizedFiles.length} 个文件` }
    );
    await this.watcher.buildBaseline(globPatterns);
    await CodeGraphCore.yieldToEventLoop();

    // 3. 架构原型初判 (Fast-Path / Universal)
    const archetypeMatch = this.forceArchetype
      ? { archetype: this.forceArchetype, confidence: 1.0, matchedRules: ['用户手动强制指定'] }
      : ArchetypeEngine.detectArchetype(this.workspaceRoot, normalizedFiles);

    // 4. 遍历解析所有源码文件的 AST (最耗时阶段：进度条 12% → 82%)
    const totalFiles = normalizedFiles.length;
    this.reportProgress('parsing', `开始解析 ${totalFiles} 个文件的 AST…`, 0, totalFiles, 12);
    let parsed = 0;
    const parseStart = Date.now();
    for (const relPath of normalizedFiles) {
      const fullPath = path.join(this.workspaceRoot, relPath);
      const extractor = ExtractorRegistry.getExtractorForFile(relPath);
      if (!extractor) {
        parsed++;
        continue;
      }

      try {
        const sourceCode = fs.readFileSync(fullPath, 'utf-8');
        const grammarName = ExtractorRegistry.getWasmGrammarForFile(relPath) || extractor.wasmGrammarName;
        const parser = await getParserForLanguage(grammarName);
        const tree = parser.parse(sourceCode);
        const extraction = extractor.extractFile(tree, relPath, sourceCode);

        // 为该文件提取出的所有符号节点注入所属工程 projectId
        const fileProjId = this.getFileProjectId(relPath);
        if (fileProjId) {
          for (const n of extraction.nodes) {
            n.projectId = fileProjId;
          }
        }

        this.symbolTable.registerFileExtraction(extraction);
      } catch (err) {
        console.warn(`[CodeGraph] 解析文件失败: ${relPath}`, err);
      }

      parsed++;
      // 每 5 个文件刷新一次进度，并让出事件循环，避免同步 WASM 解析
      // 把 HTTP 服务彻底饿死 (否则 /api/progress 会超时)。
      if (parsed % 5 === 0 || parsed === totalFiles) {
        const frac = totalFiles > 0 ? parsed / totalFiles : 1;
        const percent = 12 + frac * 70; // 12% → 82%
        const elapsed = Date.now() - parseStart;
        const etaMs = parsed > 0 && parsed < totalFiles ? Math.round((elapsed / parsed) * (totalFiles - parsed)) : 0;
        this.reportProgress(
          'parsing',
          `正在解析 AST：${parsed} / ${totalFiles} 个文件`,
          parsed,
          totalFiles,
          percent,
          { etaMs }
        );
        await CodeGraphCore.yieldToEventLoop();
      }
    }
    this.reportProgress(
      'parsing',
      `AST 解析完成：${parsed} 个文件`,
      parsed,
      totalFiles,
      82,
      { log: `AST 解析完成：${parsed} 个文件，用时 ${Date.now() - parseStart}ms` }
    );

    // 5. 全局跨文件调用与依赖关系解析 + 跨语言契约中枢自动链接
    this.reportProgress('resolving', '正在解析跨文件调用与跨语言契约…', 0, 0, 86);
    // 让出一次事件循环，使前端能先看到本阶段 (该步骤本身是同步且耗时的)
    await CodeGraphCore.yieldToEventLoop();
    this.symbolTable.resolveCrossFileReferences();

    // 6. 双模型编译 (含一致性校验与自动纠错回滚及多端生态聚合)
    this.reportProgress('compiling', '正在编译架构图谱与时序流程…', 0, 0, 92);
    await CodeGraphCore.yieldToEventLoop();
    const projectName = path.basename(this.workspaceRoot);
    const activeProjects = this.projects.filter((p) => this.selectedProjectIds.includes(p.id));

    const result = DualModelCompiler.compile(
      projectName,
      this.scopePath,
      normalizedFiles,
      this.symbolTable.getAllNodes(),
      this.symbolTable.getAllEdges(),
      archetypeMatch.archetype,
      {
        projects: activeProjects.length > 0 ? activeProjects : this.projects,
        activeProjectId: this.activeProjectId,
      }
    );

    this.lastGraphResult = result;
    const duration = Date.now() - startTime;
    this.reportProgress(
      'done',
      `扫描完成：${result.meta.nodeCount} 节点 / ${result.meta.edgeCount} 关系`,
      normalizedFiles.length,
      normalizedFiles.length,
      100,
      { log: `扫描完成，用时 ${duration}ms` }
    );
    console.log(
      `[CodeGraph] 全量扫描完成: ${normalizedFiles.length} 个文件, ${result.meta.nodeCount} 节点, ${result.meta.edgeCount} 关系 (耗时 ${duration}ms)`
    );
    return result;
  }

  /**
   * 极速双轨增量同步 (仅针对变更文件做局部 AST 手术式置换)
   */
  public async updateIncremental(): Promise<FullGraphResult> {
    const startTime = Date.now();
    const globPatterns = ExtractorRegistry.getGlobPatterns();
    const changes = await this.watcher.detectChanges(globPatterns);

    const totalChanged = changes.added.length + changes.modified.length + changes.deleted.length;
    if (totalChanged === 0 && this.lastGraphResult) {
      return this.lastGraphResult;
    }

    // 1. 处理被删除的文件
    for (const del of changes.deleted) {
      this.symbolTable.invalidateFile(del);
    }

    // 2. 局部重新解析新增与修改的文件
    for (const changedFile of [...changes.added, ...changes.modified]) {
      const fullPath = path.join(this.workspaceRoot, changedFile);
      const extractor = ExtractorRegistry.getExtractorForFile(changedFile);
      if (fs.existsSync(fullPath) && extractor) {
        try {
          const sourceCode = fs.readFileSync(fullPath, 'utf-8');
          const grammarName = ExtractorRegistry.getWasmGrammarForFile(changedFile) || extractor.wasmGrammarName;
          const parser = await getParserForLanguage(grammarName);
          const tree = parser.parse(sourceCode);
          const extraction = extractor.extractFile(tree, changedFile, sourceCode);

          const fileProjId = this.getFileProjectId(changedFile);
          if (fileProjId) {
            for (const n of extraction.nodes) {
              n.projectId = fileProjId;
            }
          }

          this.symbolTable.registerFileExtraction(extraction);
        } catch (err) {
          console.warn(`[CodeGraph] 增量更新文件失败: ${changedFile}`, err);
        }
      }
    }

    // 3. 重新建立跨文件调用依赖关系与契约链接
    this.symbolTable.resolveCrossFileReferences();

    // 4. 重新编译图谱
    const allFiles = Array.from(
      new Set(
        this.symbolTable
          .getAllNodes()
          .map((n) => n.filePath)
          .filter((f) => !f.startsWith('contracts/'))
      )
    );

    const projectName = path.basename(this.workspaceRoot);
    const activeProjects = this.projects.filter((p) => this.selectedProjectIds.includes(p.id));

    const result = DualModelCompiler.compile(
      projectName,
      this.scopePath,
      allFiles,
      this.symbolTable.getAllNodes(),
      this.symbolTable.getAllEdges(),
      this.lastGraphResult?.meta.archetype || 'UNIVERSAL',
      {
        projects: activeProjects.length > 0 ? activeProjects : this.projects,
        activeProjectId: this.activeProjectId,
      }
    );

    this.lastGraphResult = result;
    const duration = Date.now() - startTime;
    console.log(
      `[CodeGraph] 增量更新完成 (${changes.isGitAccelerated ? 'Git加速' : 'Hash比对'}): 变动 ${totalChanged} 文件 (耗时 ${duration}ms)`
    );
    return result;
  }

  public getLastResult(): FullGraphResult | undefined {
    return this.lastGraphResult;
  }

  public getLastLayout(): { architecture?: any; drilldowns?: Record<string, { layout: any; portEdges: any[]; version?: string }> } | undefined {
    return this.lastLayout;
  }

  public setLastLayout(layout: { architecture?: any; drilldowns?: Record<string, { layout: any; portEdges: any[]; version?: string }> }): void {
    this.lastLayout = layout;
  }

  /**
   * 将当前图谱及布局缓存至本地 .codegraph/graph-cache.json
   */
  public saveToCache(layout?: { architecture?: any; drilldowns?: Record<string, { layout: any; portEdges: any[]; version?: string }> }): void {
    if (layout) {
      this.lastLayout = layout;
    }
    if (this.lastGraphResult) {
      const data: PersistentCacheData = {
        version: 1,
        savedAt: new Date().toISOString(),
        workspaceRoot: this.workspaceRoot,
        scopePath: this.scopePath,
        graph: this.lastGraphResult,
        layout: this.lastLayout,
        baselineHashes: this.watcher.getHashMap(),
        extractions: this.symbolTable.dumpExtractions(),
      };
      saveCache(this.workspaceRoot, data);
    }
  }

  /**
   * 从本地 .codegraph/graph-cache.json 恢复图谱、布局及文件哈希基准与语法索引
   */
  public loadFromCache(): PersistentCacheData | null {
    const cached = loadCache(this.workspaceRoot);
    if (cached && cached.graph) {
      this.lastGraphResult = cached.graph;
      this.lastLayout = cached.layout;
      if (cached.baselineHashes) {
        this.watcher.setHashMap(cached.baselineHashes);
      }
      if (cached.extractions) {
        this.symbolTable.loadExtractions(cached.extractions);
      }
      // 关键：必须一并恢复工程画像与勾选状态。
      // 否则进程重启后 this.projects 为空，switchActiveProject() 会因为
      // activeProjects 为空而退化为「通用/社区聚类」图谱 —— 表现为界面显示的
      // 还是旧的系统类型，且无法按工程切换。
      const cachedProjects = cached.graph.meta?.projects;
      if (Array.isArray(cachedProjects) && cachedProjects.length > 0) {
        this.projects = cachedProjects;
        if (this.selectedProjectIds.length === 0) {
          const recommended = this.projects.filter((p) => p.isRecommended).map((p) => p.id);
          this.selectedProjectIds = recommended.length > 0 ? recommended : this.projects.map((p) => p.id);
        }
      }
      this.activeProjectId = cached.graph.meta?.activeProjectId || undefined;
      return cached;
    }
    return null;
  }

  public hasCache(): boolean {
    return hasCache(this.workspaceRoot);
  }

  public dispose(): void {
    // 清理资源
  }
}
