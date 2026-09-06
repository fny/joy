/**
 * Keyframes for the web shake, COMPOSED with the element's existing transform.
 *
 * `animate()` replaces the transform property while it runs, and a `forwards`
 * fill kept the final `translateX(0px)` applied forever — a view styled with
 * scale/rotate lost that transform permanently after one shake (#239). Each
 * keyframe therefore prefixes the base transform (the computed matrix), the
 * last keyframe returns to offset 0, and the animation is not filled, so the
 * element's own style is what remains when it ends.
 */
export function shakeKeyframes(amplitude: number = 3.0, count: number = 4, decay: boolean = false): number[] {
    const keyframes: number[] = [0];
    for (let i = 0; i < count; i++) {
        const sign = (i % 2 === 0) ? 1.0 : -1.0;
        const multiplier = decay ? (1.0 / (i + 1)) : 1.0;
        keyframes.push(amplitude * sign * multiplier);
    }
    keyframes.push(0);
    return keyframes;
}

export function composeShakeTransforms(baseTransform: string | null | undefined, offsets: number[]): string[] {
    const base = baseTransform && baseTransform !== 'none' ? `${baseTransform} ` : '';
    return offsets.map((o) => `${base}translateX(${o}px)`);
}
