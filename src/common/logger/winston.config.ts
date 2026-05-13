import * as winston from 'winston';

const consoleFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, context }) => {
        const ctx = context ? ` [${String(context)}]` : '';
        return `[${String(timestamp)}] ${level}${ctx}: ${String(message)}`;
    }),
);

const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
);

export const winstonConfig: winston.LoggerOptions = {
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: fileFormat,
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
            format: fileFormat,
        }),
    ],
};
