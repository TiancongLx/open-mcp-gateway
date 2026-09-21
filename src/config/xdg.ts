import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';

const APP_NAME = 'open-mcp-gateway';

export interface XdgEnvironment {
    configBase: string;
    dataBase: string;
    stateBase: string;
    cacheBase: string;
    configHome: string;
    dataHome: string;
    stateHome: string;
    cacheHome: string;
    activeConfigFile: string;
    logFilePath: string;
}

export function resolveXdg(): XdgEnvironment {
    const isWindows = process.platform === 'win32';
    const home = homedir();

    // 基础根目录解析
    let configBase = process.env.XDG_CONFIG_HOME || (isWindows ? (process.env.APPDATA || join(home, 'AppData', 'Roaming')) : join(home, '.config'));
    let dataBase   = process.env.XDG_DATA_HOME   || (isWindows ? (process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')) : join(home, '.local', 'share'));
    let stateBase  = process.env.XDG_STATE_HOME  || (isWindows ? (process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')) : join(home, '.local', 'state'));
    let cacheBase  = process.env.XDG_CACHE_HOME  || (isWindows ? (process.env.TEMP || join(home, 'AppData', 'Local', 'Temp')) : join(home, '.cache'));

    // 应用级专属目录
    const configHome = join(configBase, APP_NAME);
    const dataHome   = join(dataBase, APP_NAME);
    const stateHome  = join(stateBase, APP_NAME);
    const cacheHome  = join(cacheBase, APP_NAME);
    const logDir     = join(stateHome, 'logs');

    for (const dir of [configHome, dataHome, stateHome, logDir, cacheHome]) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    const candidatePaths = [
        process.env.MCP_OPEN_GATEWAY_CONFIG,
        join(process.cwd(), 'config.json5'),
        join(configHome, 'config.json5'),
        join(configHome, 'config.json'),
    ].filter(Boolean) as string[];

    let activeConfigFile = candidatePaths[candidatePaths.length - 1];
    for (const p of candidatePaths) {
        if (existsSync(p)) {
            activeConfigFile = p;
            break;
        }
    }

    const logFilePath = join(logDir, 'gateway.log');

    return {
        configBase,
        dataBase,
        stateBase,
        cacheBase,
        configHome,
        dataHome,
        stateHome,
        cacheHome,
        activeConfigFile: resolve(activeConfigFile),
        logFilePath: resolve(logFilePath),
    };
}

export function interpolateVariables(rawText: string, xdg: XdgEnvironment): string {
    let result = rawText.trim();

    if (result.startsWith('~/') || result.startsWith('~\\')) {
        result = join(homedir(), result.slice(2));
    }

    // 1. 标准 XDG 根目录替换
    result = result.replace(/\$\{XDG_CONFIG_HOME\}/g, xdg.configBase);
    result = result.replace(/\$\{XDG_DATA_HOME\}/g, xdg.dataBase);
    result = result.replace(/\$\{XDG_STATE_HOME\}/g, xdg.stateBase);
    result = result.replace(/\$\{XDG_CACHE_HOME\}/g, xdg.cacheBase);

    // 2. 应用专属实体目录替换
    result = result.replace(/\$\{APP_CONFIG_DIR\}/g, xdg.configHome);
    result = result.replace(/\$\{APP_DATA_DIR\}/g, xdg.dataHome);
    result = result.replace(/\$\{APP_STATE_DIR\}/g, xdg.stateHome);
    result = result.replace(/\$\{APP_CACHE_DIR\}/g, xdg.cacheHome);

    // 3. 通用环境变量替换
    if (process.platform === 'win32') {
        result = result.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
    }
    result = result.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');

    return result;
}
