export enum LogLevel {
    NONE = 0,
    ERROR = 1,
    WARN = 2,
    INFO = 3,
    DEBUG = 4,
    TRACE = 5,
}

const LOG_COLORS: Record<LogLevel, string> = {
    [LogLevel.NONE]: '',          // Pas utilisé
    [LogLevel.ERROR]: '\x1b[31m', // Rouge
    [LogLevel.WARN]: '\x1b[33m',  // Jaune
    [LogLevel.INFO]: '\x1b[36m',  // Cyan
    [LogLevel.DEBUG]: '\x1b[35m', // Magenta
    [LogLevel.TRACE]: '\x1b[90m', // Gris
};

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

class Logger {
    private level: LogLevel;
    private moduleColors: Map<string, string> = new Map();
    private colorIndex = 0;
    private availableColors = [
        '\x1b[32m', // Vert
        '\x1b[34m', // Bleu
        '\x1b[35m', // Magenta
        '\x1b[36m', // Cyan
        '\x1b[93m', // Jaune clair
        '\x1b[94m', // Bleu clair
        '\x1b[95m', // Magenta clair
        '\x1b[96m', // Cyan clair
    ];

    constructor() {
        const levelFromEnv = process.env.LOG_LEVEL?.toUpperCase() || 'INFO';
        this.level = this.parseLevel(levelFromEnv);

        if (this.level >= LogLevel.DEBUG) {
            console.log(`${BOLD}[Logger]${RESET} Niveau de log: ${LogLevel[this.level]} (${this.level})`);
        }
    }

    private parseLevel(level: string): LogLevel {
        switch (level) {
            case 'NONE': return LogLevel.NONE;
            case 'ERROR': return LogLevel.ERROR;
            case 'WARN': return LogLevel.WARN;
            case 'INFO': return LogLevel.INFO;
            case 'DEBUG': return LogLevel.DEBUG;
            case 'TRACE': return LogLevel.TRACE;
            default: return LogLevel.INFO;
        }
    }

    private getModuleColor(module: string): string {
        if (!this.moduleColors.has(module)) {
            this.moduleColors.set(module, this.availableColors[this.colorIndex % this.availableColors.length]);
            this.colorIndex++;
        }
        return this.moduleColors.get(module)!;
    }

    private formatTimestamp(): string {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 23);
    }

    private formatMessage(level: LogLevel, module: string, message: string, data?: any): string {
        const timestamp = this.formatTimestamp();
        const levelName = LogLevel[level].padEnd(5);
        const levelColor = LOG_COLORS[level] || '';
        const moduleColor = this.getModuleColor(module);

        let formatted = `${BOLD}${timestamp}${RESET} ${levelColor}${levelName}${RESET} ${moduleColor}[${module}]${RESET} ${message}`;

        if (data !== undefined) {
            if (data instanceof Error) {
                formatted += ` ${data.message}`;
                if (data.stack) {
                    formatted += '\n' + data.stack;
                }
            } else if (typeof data === 'object') {
                formatted += '\n' + JSON.stringify(data, null, 2);
            } else {
                formatted += ` ${data}`;
            }
        }

        return formatted;
    }

    private log(level: LogLevel, module: string, message: string, data?: any): void {
        if (level <= this.level) {
            console.log(this.formatMessage(level, module, message, data));
        }
    }

    error(module: string, message: string, data?: any): void {
        this.log(LogLevel.ERROR, module, message, data);
    }

    warn(module: string, message: string, data?: any): void {
        this.log(LogLevel.WARN, module, message, data);
    }

    info(module: string, message: string, data?: any): void {
        this.log(LogLevel.INFO, module, message, data);
    }

    debug(module: string, message: string, data?: any): void {
        this.log(LogLevel.DEBUG, module, message, data);
    }

    trace(module: string, message: string, data?: any): void {
        this.log(LogLevel.TRACE, module, message, data);
    }

    // Méthode pour créer un logger avec un module pré-défini
    createModuleLogger(module: string) {
        return {
            error: (message: string, data?: any) => this.error(module, message, data),
            warn: (message: string, data?: any) => this.warn(module, message, data),
            info: (message: string, data?: any) => this.info(module, message, data),
            debug: (message: string, data?: any) => this.debug(module, message, data),
            trace: (message: string, data?: any) => this.trace(module, message, data),
        };
    }
}

export const logger = new Logger();
