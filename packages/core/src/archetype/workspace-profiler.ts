import fs from 'fs';
import path from 'path';
import {
  ProjectPlatform,
  ProjectKind,
  DetectedProjectProfile,
  WorkspaceDiscoveryResult,
} from '../types/index.js';
import { sanitizeIdentifier } from '../parser/scip-utils.js';

export class WorkspaceProfiler {
  /** 目录嗅探的最大深度 (仅用于寻找工程根，不影响工程内部的代码解析深度)。 */
  private static readonly MAX_SCAN_DEPTH = 6;

  /** 统计代码文件时的递归上限；过低会截断深层目录 (如 Android/app/src/main/java/...)。 */
  private static readonly MAX_COUNT_DEPTH = 14;

  /** 遍历时一律跳过的重型/生成目录。 */
  private static readonly IGNORED_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    'venv',
    '.venv',
    '__pycache__',
    'target',
    'bin',
    'obj',
    'dist',
    'build',
    'build-out',
    '.gradle',
    '.idea',
    '.vs',
    '.vscode',
    '.kotlin',
    '.next',
    '.turbo',
    'appdata',
    'coverage',
  ]);

  /** .NET 工程文件后缀 (用于桌面端形态判定)。 */
  private static readonly DOTNET_SUFFIXES = [
    '.csproj',
    '.fsproj',
    '.vbproj',
    '.sln',
    '.slnx',
    '.wapproj',
    '.vcxproj',
  ];

  /**
   * 1. 系统关键路径与敏感盘符硬拦截检查
   */
  public static checkDangerousRoot(targetPath: string): { isDangerous: boolean; reason?: string } {
    const resolved = path.resolve(targetPath);
    const normalized = resolved.replace(/\\/g, '/');

    // 1.1 磁盘根目录拦截 (如 C:\, D:\, /)
    if (/^[a-zA-Z]:\/?$/.test(normalized) || normalized === '/') {
      return {
        isDangerous: true,
        reason: `您选择的是磁盘根目录 (${resolved})。为防止递归全盘导致系统卡死，请选择具体的开发项目子文件夹。`,
      };
    }

    // 1.2 系统级保护目录拦截
    const systemProtectedDirs = [
      'c:/windows',
      'c:/program files',
      'c:/program files (x86)',
      'c:/programdata',
      '/system',
      '/usr',
      '/etc',
      '/bin',
      '/sbin',
      '/var',
    ];

    const lower = normalized.toLowerCase();
    for (const sysDir of systemProtectedDirs) {
      if (lower === sysDir || lower.startsWith(sysDir + '/')) {
        return {
          isDangerous: true,
          reason: `路径 (${resolved}) 属于操作系统保护目录，不可作为代码分析工作区。`,
        };
      }
    }

    // 1.3 用户系统主目录拦截 (如 C:\Users\Username)
    // 检查是否直接包含了 Desktop, AppData, Documents 等顶级系统文件夹且根部没有任何项目描述文件
    if (/^[a-zA-Z]:\/users\/[^/]+$/i.test(normalized)) {
      try {
        const entries = fs.readdirSync(resolved);
        const hasSysFolders = entries.some((e) => /^(desktop|documents|appdata|downloads|pictures)$/i.test(e));
        const hasProjectAnchor = entries.some((e) =>
          /^(package\.json|go\.mod|pom\.xml|cargo\.toml|requirements\.txt|\.git)$/i.test(e)
        );
        if (hasSysFolders && !hasProjectAnchor) {
          return {
            isDangerous: true,
            reason: `您选择的是用户全局主目录 (${resolved})。请进入具体的子项目文件夹（如工作区或代码库）进行分析。`,
          };
        }
      } catch {}
    }

    return { isDangerous: false };
  }

  /**
   * 2. 多工程与多端画像智能嗅探
   *
   * 心智模型 (修复多端多仓被过度切分的问题)：
   *   - 一个「工程」= 一个版本库边界 (含 .git) 或构建系统顶层工程根 (settings.gradle / .sln / go.mod ...)。
   *   - 一旦某个目录被判定为工程，就**不再向下寻找工程**。构建模块 (Gradle include、
   *     .csproj、Cargo crate) 属于其所属工程，默认不单独列出，仅计入 moduleCount。
   *   - 因此 NotifyRelay 这类多仓多端工作区得到的是「Android / Windows / Gamebar / LSP」4 个工程，
   *     而不是每个 build.gradle.kts 各算一个。
   */
  public static discover(workspaceRoot: string): WorkspaceDiscoveryResult {
    const root = path.resolve(workspaceRoot);
    const dangerCheck = this.checkDangerousRoot(root);
    if (dangerCheck.isDangerous) {
      return {
        isSingleProject: false,
        hasDangerousRoot: true,
        dangerousRootReason: dangerCheck.reason,
        projects: [],
      };
    }

    const detectedDirs: Array<{ dir: string; kind: ProjectKind }> = [];
    const visitedRealPaths = new Set<string>();

    const scanDirForProjects = (currentDir: string, currentDepth: number) => {
      if (currentDepth > this.MAX_SCAN_DEPTH) return;

      let realPath: string;
      try {
        realPath = fs.realpathSync(currentDir);
      } catch {
        return;
      }

      // 软链接循环环路防护 (Symlink Cycle Guard)
      if (visitedRealPaths.has(realPath)) return;
      visitedRealPaths.add(realPath);

      // 当前目录本身就是一个工程 → 登记后**停止下钻**。
      // 这正是「不再把 Android/app、Windows/src 等内部模块当成独立工程」的关键。
      if (this.hasRepoMarker(currentDir)) {
        detectedDirs.push({ dir: currentDir, kind: 'REPO' });
        return;
      }
      if (this.hasBuildRootMarker(currentDir)) {
        detectedDirs.push({ dir: currentDir, kind: 'SUBPROJECT' });
        return;
      }
      if (this.hasProjectAnchor(currentDir)) {
        detectedDirs.push({ dir: currentDir, kind: 'SUBPROJECT' });
        return;
      }

      // 不是工程 → 继续向子目录寻找工程根
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name.startsWith('.') && name !== '.git') continue;
        if (this.IGNORED_DIR_NAMES.has(name.toLowerCase())) continue;
        scanDirForProjects(path.join(currentDir, name), currentDepth + 1);
      }
    };

    scanDirForProjects(root, 1);

    // 完全没探测到工程：把根目录本身作为单工程
    if (detectedDirs.length === 0) {
      return {
        isSingleProject: true,
        hasDangerousRoot: false,
        projects: [this.profileProject(root, root, 'REPO')],
      };
    }

    const projects: DetectedProjectProfile[] = detectedDirs.map((d) =>
      this.profileProject(root, d.dir, d.kind)
    );

    // 执行多端生态智能组合推荐算法 (Multi-Platform Ecosystem Grouping)
    this.applySmartRecommendations(projects);

    return {
      isSingleProject: projects.length <= 1,
      hasDangerousRoot: false,
      projects,
    };
  }

  /** 版本库边界：`.git` 目录或 `.git` 文件 (worktree / submodule)。 */
  private static hasRepoMarker(dirPath: string): boolean {
    try {
      return fs.existsSync(path.join(dirPath, '.git'));
    } catch {
      return false;
    }
  }

  /**
   * 构建系统顶层工程根。
   * 与 hasProjectAnchor 的区别：这里只认「整个工程的总入口」，
   * 例如 settings.gradle 表示一个 Gradle 多模块工程，而单个 build.gradle 只是其中一个模块。
   */
  private static hasBuildRootMarker(dirPath: string): boolean {
    const roots = [
      'settings.gradle',
      'settings.gradle.kts',
      'pnpm-workspace.yaml',
      'go.mod',
      'pom.xml',
      'tauri.conf.json',
      'pubspec.yaml',
    ];
    try {
      const files = fs.readdirSync(dirPath);
      const lower = new Set(files.map((f) => f.toLowerCase()));
      if (roots.some((r) => lower.has(r))) return true;
      // 解决方案文件 / 工作区清单
      for (const f of lower) {
        if (f.endsWith('.sln') || f.endsWith('.slnx')) return true;
      }
      // Cargo 工作区 (含 [workspace] 断言的 Cargo.toml)
      if (lower.has('cargo.toml')) {
        try {
          const text = fs.readFileSync(path.join(dirPath, 'Cargo.toml'), 'utf-8');
          if (/^\s*\[workspace\]/m.test(text)) return true;
        } catch {}
      }
      // package.json 声明 workspaces 才视为 monorepo 根
      if (lower.has('package.json')) {
        try {
          const text = fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8');
          if (/"workspaces"\s*:/.test(text)) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  /**
   * 检查指定目录是否包含工程描述锚点 (即「这是一个可独立分析的工程」)。
   */
  private static hasProjectAnchor(dirPath: string): boolean {
    const anchors = [
      'package.json',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'cargo.toml',
      'requirements.txt',
      'pyproject.toml',
      'setup.py',
      'pipfile',
      'cmakelists.txt',
      'makefile',
      'androidmanifest.xml',
      'tauri.conf.json',
      'pubspec.yaml',
      '.git',
    ];

    try {
      const files = fs.readdirSync(dirPath);
      const lowerFiles = new Set(files.map((f) => f.toLowerCase()));
      for (const a of anchors) {
        if (lowerFiles.has(a)) return true;
      }
      // 检查 .sln / .csproj / .vcxproj / .wapproj
      for (const f of lowerFiles) {
        if (
          f.endsWith('.sln') ||
          f.endsWith('.slnx') ||
          f.endsWith('.csproj') ||
          f.endsWith('.vcxproj') ||
          f.endsWith('.wapproj')
        ) {
          return true;
        }
      }
    } catch {}

    return false;
  }

  /** 在有限深度内递归收集匹配文件的内容 (小写)，用于识别技术栈。 */
  private static collectFileText(
    dir: string,
    match: (lowerName: string) => boolean,
    maxDepth: number
  ): string {
    let text = '';
    const walk = (d: string, depth: number) => {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          const n = e.name.toLowerCase();
          if (n.startsWith('.') || this.IGNORED_DIR_NAMES.has(n)) continue;
          walk(path.join(d, e.name), depth + 1);
        } else if (match(e.name.toLowerCase())) {
          try {
            text += fs.readFileSync(path.join(d, e.name), 'utf-8').toLowerCase() + '\n';
          } catch {}
        }
      }
    };
    walk(dir, 1);
    return text;
  }

  /** .NET 工程文件信号 (WPF / WinForms / UWP / WinUI / MAUI 判定)。 */
  private static collectDotnetSignal(dir: string): string {
    return this.collectFileText(
      dir,
      (n) => this.DOTNET_SUFFIXES.some((s) => n.endsWith(s)),
      3
    );
  }

  /** 是否存在 AndroidManifest.xml (允许位于 app/src/main 等浅层子目录)。 */
  private static hasAndroidManifestWithin(dir: string, maxDepth = 4): boolean {
    const walk = (d: string, depth: number): boolean => {
      if (depth > maxDepth) return false;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          const n = e.name.toLowerCase();
          if (n.startsWith('.') || this.IGNORED_DIR_NAMES.has(n)) continue;
          if (walk(path.join(d, e.name), depth + 1)) return true;
        } else if (e.name.toLowerCase() === 'androidmanifest.xml') {
          return true;
        }
      }
      return false;
    };
    return walk(dir, 1);
  }

  /** Gradle 脚本中的 Android 插件信号。 */
  private static collectGradleSignal(dir: string): string {
    return this.collectFileText(
      dir,
      (n) => n === 'build.gradle' || n === 'build.gradle.kts' || n === 'settings.gradle' || n === 'settings.gradle.kts',
      2
    );
  }

  /**
   * 统计工程内部的构建模块数量 (Gradle include / .NET 工程文件 / Cargo crate 等)。
   * 这些模块不再单独成为「工程」，但数量对理解工程规模有意义。
   */
  private static countBuildModules(dir: string): number {
    let modules = 0;

    // Gradle: 解析 settings.gradle(.kts) 的 include(":x") 声明
    for (const settings of ['settings.gradle', 'settings.gradle.kts']) {
      const p = path.join(dir, settings);
      if (!fs.existsSync(p)) continue;
      try {
        const text = fs.readFileSync(p, 'utf-8');
        const matches = text.match(/include\s*\(?\s*["'][:\s]*[A-Za-z0-9_-]+["']/g);
        if (matches) modules += matches.length;
      } catch {}
    }
    if (modules > 0) return modules;

    // .NET: 统计 .csproj / .wapproj / .vcxproj
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          const n = e.name.toLowerCase();
          if (n.startsWith('.') || this.IGNORED_DIR_NAMES.has(n)) continue;
          walk(path.join(d, e.name), depth + 1);
        } else {
          const n = e.name.toLowerCase();
          if (n.endsWith('.csproj') || n.endsWith('.wapproj') || n.endsWith('.vcxproj')) modules++;
        }
      }
    };
    walk(dir, 1);
    if (modules > 0) return modules;

    // Cargo: 统计非根 Cargo.toml (crate)
    const walkCargo = (d: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          const n = e.name.toLowerCase();
          if (n.startsWith('.') || this.IGNORED_DIR_NAMES.has(n)) continue;
          walkCargo(path.join(d, e.name), depth + 1);
        } else if (e.name.toLowerCase() === 'cargo.toml' && d !== dir) {
          modules++;
        }
      }
    };
    walkCargo(dir, 1);

    return Math.max(modules, 0);
  }

  /**
   * 生成单个工程的 4 维画像指纹 (平台形态、技术栈、版本号、活跃度)
   */
  private static profileProject(
    workspaceRoot: string,
    projectDir: string,
    kind: ProjectKind = 'REPO'
  ): DetectedProjectProfile {
    const relPath = path.relative(workspaceRoot, projectDir).replace(/\\/g, '/') || '.';
    const dirName = path.basename(projectDir);
    const id = relPath === '.' ? 'root' : sanitizeIdentifier(relPath).toLowerCase();

    // 1. 读取依赖文件与特征内容
    let depContent = '';
    const readDep = (filename: string) => {
      const p = path.join(projectDir, filename);
      if (fs.existsSync(p)) {
        try {
          depContent += fs.readFileSync(p, 'utf-8').toLowerCase() + '\n';
        } catch {}
      }
    };
    readDep('package.json');
    readDep('requirements.txt');
    readDep('pyproject.toml');
    readDep('go.mod');
    readDep('pom.xml');
    readDep('build.gradle');
    readDep('build.gradle.kts');
    readDep('settings.gradle');
    readDep('settings.gradle.kts');
    readDep('cargo.toml');
    readDep('cmakelists.txt');

    // .NET 工程文件信号 (WPF / WinForms / UWP / WinUI)
    const dotnetSignal = this.collectDotnetSignal(projectDir);

    // 2. 统计文件数量、扩展名分布与最近编辑时间
    const extStats: Record<string, number> = {};
    let lastModifiedMs = 0;
    let fileCount = 0;

    const countFiles = (dir: string, depth: number) => {
      if (depth > this.MAX_COUNT_DEPTH) return;
      try {
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of list) {
          const itemPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            if (!this.IGNORED_DIR_NAMES.has(item.name.toLowerCase())) {
              countFiles(itemPath, depth + 1);
            }
          } else {
            const ext = path.extname(item.name).toLowerCase();
            if (/^\.(py|ts|tsx|js|jsx|go|java|kt|kts|rs|c|cpp|cc|cxx|h|hpp|cs|xaml)$/.test(ext)) {
              extStats[ext] = (extStats[ext] || 0) + 1;
              fileCount++;
              try {
                const stat = fs.statSync(itemPath);
                if (stat.mtimeMs > lastModifiedMs) {
                  lastModifiedMs = stat.mtimeMs;
                }
              } catch {}
            }
          }
        }
      } catch {}
    };

    countFiles(projectDir, 1);

    // 3. 计算主导语言 (.kts/.xaml 等从属扩展名不参与主导语言竞争)
    let primaryLanguage = 'unknown';
    let maxExtCount = 0;
    for (const [ext, count] of Object.entries(extStats)) {
      if (count > maxExtCount) {
        maxExtCount = count;
        if (['.ts', '.tsx'].includes(ext)) primaryLanguage = 'typescript';
        else if (['.js', '.jsx'].includes(ext)) primaryLanguage = 'javascript';
        else if (ext === '.py') primaryLanguage = 'python';
        else if (ext === '.go') primaryLanguage = 'go';
        else if (ext === '.java') primaryLanguage = 'java';
        else if (['.kt', '.kts'].includes(ext)) primaryLanguage = 'kotlin';
        else if (ext === '.rs') primaryLanguage = 'rust';
        else if (['.cpp', '.cc', '.cxx', '.hpp'].includes(ext)) primaryLanguage = 'cpp';
        else if (['.c', '.h'].includes(ext)) primaryLanguage = 'c';
        else if (['.cs', '.xaml'].includes(ext)) primaryLanguage = 'csharp';
      }
    }

    // 4. 识别框架与技术栈
    const frameworks: string[] = [];
    if (/(react|@types\/react)/i.test(depContent)) frameworks.push('React');
    if (/vue/i.test(depContent)) frameworks.push('Vue');
    if (/(next|nuxt)/i.test(depContent)) frameworks.push('Next.js');
    if (/vite/i.test(depContent)) frameworks.push('Vite');
    if (/(fastapi|flask|django)/i.test(depContent)) frameworks.push('FastAPI/Web');
    if (/(pyqt5|pyqt6|pyside2|pyside6|tkinter|wxpython)/i.test(depContent)) frameworks.push('PyQt');
    if (/(gin-gonic|labstack\/echo|gofiber)/i.test(depContent)) frameworks.push('Gin');
    if (/(spring-boot|spring-web)/i.test(depContent)) frameworks.push('Spring Boot');
    if (/(axum|actix-web)/i.test(depContent)) frameworks.push('Axum');
    if (/(qt5|qt6|qapplication|qmainwindow)/i.test(depContent)) frameworks.push('Qt');
    if (/(cmake)/i.test(depContent)) frameworks.push('CMake');
    if (/(electron)/i.test(depContent)) frameworks.push('Electron');
    if (/(tauri)/i.test(depContent)) frameworks.push('Tauri');
    // .NET 桌面端技术栈 (来自工程文件而非包清单)
    if (dotnetSignal) {
      if (/<usewpf>|presentationframework/.test(dotnetSignal)) frameworks.push('WPF');
      if (/<usewindowsforms>|system\.windows\.forms/.test(dotnetSignal)) frameworks.push('WinForms');
      if (/(targetplatformidentifier>\s*uap|windowsxaml|microsoft\.gaming\.xboxgamebar)/.test(dotnetSignal)) frameworks.push('UWP/GameBar');
      if (/microsoft\.windowsappsdk|winui/.test(dotnetSignal)) frameworks.push('WinUI');
      if (/microsoft\.maui/.test(dotnetSignal)) frameworks.push('MAUI');
      if (/net\d+\.\d+-windows|netcoreapp|netstandard/.test(dotnetSignal)) frameworks.push('.NET');
    }

    // 5. 判定目标平台形态 (Platform Fingerprinting)
    let platform: ProjectPlatform = 'UNKNOWN';
    const lowerRel = relPath.toLowerCase();

    // 5.1 Android (Manifest 允许位于 app/src/main，Gradle 插件声明亦可)
    const androidManifest = this.hasAndroidManifestWithin(projectDir);
    const gradleSignal = this.collectGradleSignal(projectDir);
    if (
      androidManifest ||
      fs.existsSync(path.join(projectDir, 'AndroidManifest.xml')) ||
      fs.existsSync(path.join(projectDir, 'src/main/AndroidManifest.xml')) ||
      /com\.android\.(application|library)/i.test(depContent) ||
      // 版本目录别名写法 (如 alias(libs.plugins.android.application)) 同样视为 Android 工程
      /android\.(application|library)/i.test(gradleSignal) ||
      /com\.android\.(application|library)/i.test(gradleSignal) ||
      /(android)/i.test(lowerRel)
    ) {
      platform = 'MOBILE_ANDROID';
    }
    // 5.2 iOS
    else if (
      fs.existsSync(path.join(projectDir, 'Podfile')) ||
      /(ios|apple)/i.test(lowerRel)
    ) {
      platform = 'MOBILE_IOS';
    }
    // 5.3 PC 桌面端 .NET (WPF / WinForms / UWP / WinUI / MAUI / GameBar 小组件)
    //     必须在「后端微服务」兜底之前判定，否则 C#/.NET 工程会被误标为后端 API。
    else if (
      (primaryLanguage === 'csharp' || dotnetSignal.length > 0) &&
      (frameworks.includes('WPF') ||
        frameworks.includes('WinForms') ||
        frameworks.includes('UWP/GameBar') ||
        frameworks.includes('WinUI') ||
        frameworks.includes('MAUI') ||
        /(desktop|client|pc|gui|widget|overlay|gamebar|winui|wpf|uwp|windows)/i.test(lowerRel) ||
        /<outputtype>\s*winexe/.test(dotnetSignal))
    ) {
      platform = 'DESKTOP_DOTNET';
    }
    // 5.4 PC Desktop C++
    else if (
      (primaryLanguage === 'cpp' || primaryLanguage === 'c') &&
      (frameworks.includes('Qt') || /(desktop|client|pc|gui|win32)/i.test(lowerRel))
    ) {
      platform = 'DESKTOP_CPP';
    }
    // 5.5 PC Desktop Python
    else if (
      primaryLanguage === 'python' &&
      (frameworks.includes('PyQt') || /(desktop|client|pc|gui)/i.test(lowerRel))
    ) {
      platform = 'DESKTOP_PYTHON';
    }
    // 5.6 PC Desktop Electron / Tauri
    else if (frameworks.includes('Electron') || frameworks.includes('Tauri')) {
      platform = 'DESKTOP_ELECTRON';
    }
    // 5.7 Web 前端
    else if (
      (primaryLanguage === 'typescript' || primaryLanguage === 'javascript') &&
      (frameworks.includes('React') || frameworks.includes('Vue') || frameworks.includes('Next.js') || frameworks.includes('Vite') || /(web|frontend|client|portal)/i.test(lowerRel))
    ) {
      platform = 'WEB_FRONTEND';
    }
    // 5.8 后端服务
    else if (
      frameworks.includes('FastAPI/Web') ||
      frameworks.includes('Gin') ||
      frameworks.includes('Spring Boot') ||
      frameworks.includes('Axum') ||
      /(server|backend|service|api|microservice)/i.test(lowerRel) ||
      fs.existsSync(path.join(projectDir, 'Dockerfile'))
    ) {
      platform = 'BACKEND_SERVICE';
    }
    // 5.9 辅助工具
    else if (/(tools?|scripts?|util(s)?|benchmark|test)/i.test(lowerRel)) {
      platform = 'TOOL_SCRIPT';
    }
    // 5.10 兜底分类
    else if (primaryLanguage === 'cpp') {
      platform = 'DESKTOP_CPP';
    } else if (primaryLanguage === 'python') {
      platform = 'BACKEND_SERVICE';
    } else if (primaryLanguage === 'typescript' || primaryLanguage === 'javascript') {
      platform = 'WEB_FRONTEND';
    } else if (['go', 'java', 'rust'].includes(primaryLanguage)) {
      platform = 'BACKEND_SERVICE';
    } else if (['csharp'].includes(primaryLanguage)) {
      // C#/.NET 大多是桌面端或客户端组件，不应默认归入后端微服务
      platform = 'DESKTOP_DOTNET';
    }

    // 6. 提取局域版本号 (如 v0.1.5, v0.5, 1.0, v015, v01)
    let versionString: string | undefined;
    const combinedName = relPath + '_' + dirName;
    const dottedMatch = combinedName.match(/(?:v|_|-)(\d+\.\d+(?:\.\d+)*)/i);
    if (dottedMatch) {
      versionString = `v${dottedMatch[1]}`;
    } else {
      const compactMatch = combinedName.match(/(?:^|[_/-])[vV](\d{1,4})(?:$|[_/-])/);
      if (compactMatch) {
        const digits = compactMatch[1];
        if (digits.length === 2) {
          versionString = `v${digits[0]}.${digits[1]}`;
        } else if (digits.length === 3) {
          versionString = `v${digits[0]}.${digits[1]}.${digits[2]}`;
        } else {
          versionString = `v${digits}`;
        }
      }
    }

    const moduleCount = this.countBuildModules(projectDir);

    return {
      id,
      name: dirName || relPath,
      relPath,
      platform,
      primaryLanguage,
      frameworks,
      versionString,
      lastModifiedMs,
      fileCount,
      isRecommended: true, // 初始置为 true，由后续推荐决策矩阵调整
      recommendReason: '全端协同生态推荐项',
      kind,
      moduleCount,
    };
  }

  /**
   * 3. 智能生态矩阵聚合决策 (组合出最佳多端协同生态)
   *
   * 修正点：不再对「同一族系」一刀切只留一个主力。
   *   - 独立仓库 (REPO) 是彼此独立的交付物 (Android 端 / PC 端 / 小组件端)，
   *     即使平台相同也应全部保留为推荐项。
   *   - 只有当**同一个工程内部**存在同平台的多个候选 (真正的版本分支/历史副本) 时，
   *     才按 (版本号, 代码规模, 活跃度) 选出主力，其余降级为备选。
   */
  private static applySmartRecommendations(profiles: DetectedProjectProfile[]): void {
    if (profiles.length <= 1) return;

    // 先标记明确处于归档/历史目录下的工程
    for (const p of profiles) {
      if (this.isArchiveDirectory(p.relPath)) {
        p.isRecommended = false;
        p.recommendReason = '历史归档 / 早期版本 (备选参考)';
      }
    }

    // 按平台生态族系 (MOBILE, DESKTOP, WEB, BACKEND, SDK, TOOL) 再按具体平台分组
    const familyGroups = new Map<string, Map<ProjectPlatform, DetectedProjectProfile[]>>();
    for (const p of profiles) {
      const family = this.getPlatformFamily(p.platform);
      let byPlatform = familyGroups.get(family);
      if (!byPlatform) {
        byPlatform = new Map();
        familyGroups.set(family, byPlatform);
      }
      const list = byPlatform.get(p.platform) || [];
      list.push(p);
      byPlatform.set(p.platform, list);
    }

    for (const [family, byPlatform] of familyGroups.entries()) {
      // 辅助工具默认不作为核心主力推荐
      if (family === 'TOOL') {
        for (const group of byPlatform.values()) {
          for (const item of group) {
            item.isRecommended = false;
            item.recommendReason = '辅助工具 / 开发脚本 (备选)';
          }
        }
        continue;
      }

      for (const group of byPlatform.values()) {
        // 归档工程保持「非推荐」，不参与主力竞争
        const candidates = group.filter((p) => !this.isArchiveDirectory(p.relPath));
        if (candidates.length === 0) continue;

        const displayName = this.getPlatformDisplayName(candidates[0].platform);

        if (candidates.length === 1) {
          const only = candidates[0];
          only.isRecommended = true;
          only.recommendReason = this.describeReason(only, `${displayName} (${only.versionString || '最新活跃'})`);
          continue;
        }

        // 多个同平台候选：若它们分属不同的独立仓库，则都是独立交付物，全部保留。
        const repos = candidates.filter((p) => (p.kind ?? 'REPO') === 'REPO');
        const distinctRepos = new Set(repos.map((p) => p.relPath));
        if (repos.length === candidates.length && distinctRepos.size === candidates.length) {
          for (const item of candidates) {
            item.isRecommended = true;
            item.recommendReason = this.describeReason(
              item,
              `${displayName} · 独立仓库 (全端协同生态)`
            );
          }
          continue;
        }

        // 同一工程内的多个同平台候选 → 选出主力，其余作为备选分支
        candidates.sort((a, b) => {
          const verA = this.parseSemVer(a.versionString);
          const verB = this.parseSemVer(b.versionString);
          if (verA !== verB) return verB - verA;
          if (a.fileCount !== b.fileCount) return b.fileCount - a.fileCount;
          return b.lastModifiedMs - a.lastModifiedMs;
        });

        const winner = candidates[0];
        winner.isRecommended = true;
        winner.recommendReason = this.describeReason(
          winner,
          `${displayName} 当前主力 (${winner.versionString || '最新活跃'})`
        );

        for (const item of candidates.slice(1)) {
          item.isRecommended = false;
          item.recommendReason = this.isArchiveDirectory(item.relPath)
            ? '历史归档 / 早期原型 (备选参考)'
            : '同平台备选分支 / 历史版本';
        }
      }
    }
  }

  /** 在推荐理由中补充模块数量信息，便于理解工程规模。 */
  private static describeReason(p: DetectedProjectProfile, base: string): string {
    const modules = p.moduleCount ?? 0;
    return modules > 1 ? `${base} · 含 ${modules} 个构建模块` : base;
  }

  private static getPlatformFamily(p: ProjectPlatform): string {
    if (p === 'MOBILE_ANDROID' || p === 'MOBILE_IOS') return 'MOBILE';
    if (p === 'DESKTOP_CPP' || p === 'DESKTOP_PYTHON' || p === 'DESKTOP_ELECTRON' || p === 'DESKTOP_DOTNET') return 'DESKTOP';
    if (p === 'WEB_FRONTEND') return 'WEB';
    if (p === 'BACKEND_SERVICE') return 'BACKEND';
    if (p === 'SHARED_SDK') return 'SDK';
    if (p === 'TOOL_SCRIPT') return 'TOOL';
    return 'UNKNOWN';
  }

  private static isArchiveDirectory(relPath: string): boolean {
    return /(?:^|[\\/])(?:archive|archives|backup|backups|old|legacy|deprecated|history|draft|v0)(?:$|[\\/])/i.test(
      relPath
    );
  }

  private static getPlatformDisplayName(p: ProjectPlatform): string {
    switch (p) {
      case 'MOBILE_ANDROID': return '移动端 (Android)';
      case 'MOBILE_IOS': return '移动端 (iOS)';
      case 'DESKTOP_CPP': return 'PC 桌面端 (C++)';
      case 'DESKTOP_PYTHON': return 'PC 桌面端 (Python)';
      case 'DESKTOP_ELECTRON': return 'PC 桌面端 (Electron/Tauri)';
      case 'DESKTOP_DOTNET': return 'PC 桌面端 (.NET)';
      case 'WEB_FRONTEND': return '网页前端 (Web)';
      case 'BACKEND_SERVICE': return '后端微服务 (API)';
      case 'SHARED_SDK': return '共享 SDK / 基础库';
      case 'TOOL_SCRIPT': return '辅助开发工具';
      default: return '子工程';
    }
  }

  private static parseSemVer(ver?: string): number {
    if (!ver) return 0;
    const clean = ver.replace(/^v/i, '');
    const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    return major * 10000 + minor * 100 + patch;
  }
}
