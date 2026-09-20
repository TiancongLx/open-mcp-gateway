import { format } from 'node:util';
import { appendFileSync } from 'node:fs';
import * as c from 'yoctocolors';

export const LogLevels = {
    DEBUG:  0,
    INFO:   1,
    WARN:   2,
    ERROR:  3,
    SILENT: 99,
} as const;

type LogLevelKey = keyof typeof LogLevels;
type LogLevelValue = typeof LogLevels[LogLevelKey];

interface LoggerConfig {
    level: LogLevelValue;
    showTimestamp: boolean;
    logFilePath: string | null;
}

const config: LoggerConfig = {
    level: LogLevels.DEBUG,
    showTimestamp: true,
    logFilePath: null,
};

export function setLogLevel(level: LogLevelKey): void {
    config.level = LogLevels[level];
}

export function initFileLogging(filePath: string): void {
    config.logFilePath = filePath;
}

function getTimeStamp(): string {
    if (!config.showTimestamp) return '';
    const now = new Date();
    return `[${now.toLocaleTimeString('en-US', { hour12: false })}] `;
}

function print(levelVal: LogLevelValue, textBadge: string, coloredBadge: string, message: unknown[]): void {
    if (levelVal < config.level) return;

    const formattedMessage = format(...message);
    const time = getTimeStamp();

    process.stderr.write(`${c.gray(time)}${coloredBadge} ${formattedMessage}\n`);

    if (config.logFilePath) {
        try {
            const rawLine = `${time}${textBadge} ${formattedMessage}\n`;
            appendFileSync(config.logFilePath, rawLine, { encoding: 'utf8' });
        } catch {}
    }
}

export function debug(...args: unknown[]): void {
    print(LogLevels.DEBUG, '[DEBUG]', c.bgBlack(c.white(' DEBUG ')), args);
}

export function info(...args: unknown[]): void {
    print(LogLevels.INFO, '[INFO]', c.bgBlue(c.black(' INFO ')), args);
}

export function warn(...args: unknown[]): void {
    print(LogLevels.WARN, '[WARN]', c.bgYellow(c.black(' WARN ')), args);
}

export function error(...args: unknown[]): void {
    print(LogLevels.ERROR, '[ERROR]', c.bgRed(c.black(' ERROR ')), args);
}
