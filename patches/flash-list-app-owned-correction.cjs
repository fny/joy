/**
 * @shopify/flash-list: let the app own place-keeping.
 *
 * FlashList's maintainVisibleContentPosition keeps the first visible row in
 * place when content changes — but it decides alone, cannot be coordinated
 * with the chat's scroll machine, and on web corrects from a stale recorded
 * offset. While correcting it also drops the list's onScroll for 100ms
 * (ignoreScrollEvents), hiding the reader's own scrolling from the app.
 *
 * Three additions, nothing else changes:
 *  - `maintainVisibleContentPosition.appOwnedCorrection: true` skips the
 *    library's own correction entirely (and so never sets ignoreScrollEvents).
 *    MVCP stays enabled otherwise: its native scroll anchor is still mounted.
 *  - `ref.shiftContentOffset(delta)` moves the content offset by `delta` the
 *    way the library's correction did — through that native anchor on
 *    iOS/Android, which (unlike a JS scrollTo) does not stop a fling.
 *  - `ref.cancelInitialScroll()` ends startRenderingFromBottom's initial
 *    positioning early. It otherwise keeps re-issuing "go to the last row"
 *    for 100ms after the first layout (plus a queued repeat per pass), over a
 *    restore or the reader's first scroll (gpt-6-astra review, 2026-09-28).
 *
 * The chat (packages/joy-app/sources/components/chatPlace.ts) computes the
 * deltas. Fails loudly when FlashList's code no longer matches: re-check the
 * anchors below against the new version before bumping it.
 */
const fs = require('fs');
const path = require('path');

const MARK = 'joy patch: appOwnedCorrection';
const roots = [
    path.resolve(__dirname, '..', 'node_modules/@shopify/flash-list'),
    path.resolve(__dirname, '..', 'packages/joy-app/node_modules/@shopify/flash-list'),
];

// Each edit carries its own marker (`${MARK}:<id>`) and is skipped once
// present, so a patch that grows later re-applies cleanly over an older one.
const edits = [
    {
        id: 'skip-correction',
        file: 'dist/recyclerview/hooks/useRecyclerViewController.js',
        find: `        const currentDataLength = recyclerViewManager.getDataLength();
        if (recyclerViewManager.getIsFirstLayoutComplete() &&`,
        replace: `        const currentDataLength = recyclerViewManager.getDataLength();
        // ${MARK}:skip-correction — the app computes and applies corrections itself.
        if (recyclerViewManager.props.maintainVisibleContentPosition &&
            recyclerViewManager.props.maintainVisibleContentPosition.appOwnedCorrection) {
            lastDataLengthRef.current = currentDataLength;
            return;
        }
        if (recyclerViewManager.getIsFirstLayoutComplete() &&`,
    },
    {
        id: 'initial-repeat-guard',
        file: 'dist/recyclerview/hooks/useRecyclerViewController.js',
        find: `            setTimeout(() => {
                handlerMethods.scrollToOffset({
                    offset,
                    animated: false,
                    skipFirstItemOffset: false,
                });
            }, 0);`,
        replace: `            setTimeout(() => {
                // ${MARK}:initial-repeat-guard — a cancelled initial scroll issues no more repeats.
                if (recyclerViewManager.joyInitialScrollCancelled) return;
                handlerMethods.scrollToOffset({
                    offset,
                    animated: false,
                    skipFirstItemOffset: false,
                });
            }, 0);`,
    },
    {
        id: 'ref-methods',
        file: 'dist/recyclerview/hooks/useRecyclerViewController.js',
        find: `            getNativeScrollRef: () => {
                return scrollViewRef.current;
            },`,
        replace: `            getNativeScrollRef: () => {
                return scrollViewRef.current;
            },
            // ${MARK}:ref-methods — shift the offset as the library's correction did.
            shiftContentOffset: (delta) => {
                var _a;
                if (delta === 0) return;
                if (PlatformConfig.supportsOffsetCorrection) {
                    (_a = scrollAnchorRef.current) === null || _a === void 0 ? void 0 : _a.scrollBy(delta);
                }
                else {
                    (_a = scrollViewRef.current) === null || _a === void 0 ? void 0 : _a.scrollTo({ y: recyclerViewManager.getAbsoluteLastScrollOffset() + delta, animated: false });
                }
            },
            // Stop the initial bottom positioning now.
            cancelInitialScroll: () => {
                recyclerViewManager.joyInitialScrollCancelled = true;
                recyclerViewManager.isInitialScrollComplete = true;
                pauseOffsetCorrection.current = false;
            },`,
    },
    {
        id: 'props-type',
        file: 'dist/FlashListProps.d.ts',
        find: `        startRenderingFromBottom?: boolean;`,
        replace: `        startRenderingFromBottom?: boolean;
        /** ${MARK}:props-type — skip the library's own offset correction. */
        appOwnedCorrection?: boolean;`,
    },
    {
        id: 'ref-type',
        file: 'dist/FlashListRef.d.ts',
        find: `    getNativeScrollRef: () => CompatScroller | null;`,
        replace: `    getNativeScrollRef: () => CompatScroller | null;
    /** ${MARK}:ref-type — move the content offset by delta (native: fling-safe). */
    shiftContentOffset: (delta: number) => void;
    /** Stop startRenderingFromBottom's initial positioning now. */
    cancelInitialScroll: () => void;`,
    },
];

let found = 0;
for (const root of roots) {
    if (!fs.existsSync(path.join(root, 'package.json'))) continue;
    found++;
    const byFile = new Map();
    for (const e of edits) {
        const p = path.join(root, e.file);
        if (!byFile.has(p)) byFile.set(p, fs.readFileSync(p, 'utf8'));
        let content = byFile.get(p);
        if (content.includes(`${MARK}:${e.id}`)) continue; // already applied
        if (!content.includes(e.find)) {
            throw new Error(`[flash-list-app-owned-correction] anchor "${e.id}" not found in ${p}. Either FlashList changed (update the patch), or the file holds an older revision of this patch: restore it with \`pnpm install --force\` and re-run.`);
        }
        byFile.set(p, content.replace(e.find, e.replace));
    }
    for (const [p, content] of byFile) fs.writeFileSync(p, content, 'utf8');
}
if (found === 0) console.warn('[flash-list-app-owned-correction] @shopify/flash-list not installed — skipped');
