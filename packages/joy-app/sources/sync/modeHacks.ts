export type HackableMode = {
    key: string;
    name: string;
    description?: string | null;
};

export function hackMode<T extends HackableMode>(mode: T): T {
    const normalizedName = mode.name.trim().toLowerCase();
    const normalizedKey = mode.key.trim().toLowerCase();

    if (normalizedName === 'build, build' || (normalizedKey === 'build' && normalizedName === 'build')) {
        return { ...mode, name: 'build' };
    }
    if (normalizedName === 'plan/plan' || (normalizedKey === 'plan' && normalizedName === 'plan')) {
        return { ...mode, name: 'plan' };
    }
    return mode;
}

export function hackModes<T extends HackableMode>(modes: T[]): T[] {
    return modes.map(hackMode);
}
