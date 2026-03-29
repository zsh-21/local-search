/** sudo-prompt 模块缓存：避免重复动态加载 */
let sudoPromptModule: unknown | null = null;

type SudoPromptExecError = { message?: unknown } | null | undefined;
type SudoPromptModule = {
  exec: (
    commandLine: string,
    options: { name: string },
    callback: (error: SudoPromptExecError) => void,
  ) => void;
};

function isSudoPromptModule(value: unknown): value is SudoPromptModule {
  return Boolean(value && typeof value === "object" && "exec" in value && typeof (value as { exec?: unknown }).exec === "function");
}

/** 动态加载 sudo-prompt */
async function getSudoPromptModule(): Promise<SudoPromptModule> {
  if (isSudoPromptModule(sudoPromptModule)) return sudoPromptModule;
  const moduleValue = (await import("sudo-prompt")) as { default?: unknown };
  const resolvedModule = moduleValue?.default ?? moduleValue;
  if (!isSudoPromptModule(resolvedModule)) {
    throw new Error("sudo-prompt 模块无效");
  }
  sudoPromptModule = resolvedModule;
  return resolvedModule;
}

/** 转义 Windows 命令参数 */
export function quoteCmdArg(value: string): string {
  const safeValue = String(value ?? "");
  return `"${safeValue.replace(/"/g, '""')}"`;
}

/** 以管理员权限执行命令 */
export async function sudoExec(commandLine: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const sudoPrompt = await getSudoPromptModule();
    return await new Promise((resolve) => {
      sudoPrompt.exec(
        commandLine,
        { name: "File Search" },
        (error) => {
          if (!error) {
            resolve({ ok: true });
            return;
          }
          const message = typeof error?.message === "string" ? error.message.trim() : "";
          if (message.toLowerCase().includes("user did not grant permission")) {
            resolve({ ok: false, message: "已取消或启动失败（可能是 UAC 被拒绝）" });
            return;
          }
          resolve({ ok: false, message: message || "已取消或启动失败（可能是 UAC 被拒绝）" });
        },
      );
    });
  } catch {
    return { ok: false, message: "已取消或启动失败（可能是 UAC 被拒绝）" };
  }
}
