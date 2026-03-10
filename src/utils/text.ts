export function neutralizeMentions(value: string): string {
    return value.replace(/@/g, '@\u200b');
}

export function safeContent(value: string): string {
    return neutralizeMentions(value).trim();
}

export function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    if (maxLength <= 3) {
        return value.slice(0, maxLength);
    }
    return `${value.slice(0, maxLength - 3)}...`;
}
