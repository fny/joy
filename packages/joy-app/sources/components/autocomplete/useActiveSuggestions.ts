import { ValueSync } from '@/utils/sync';
import { isLatest, nextGen, retire, useLatestKey } from '@/utils/latest';
import * as React from 'react';

interface SuggestionOptions {
    clampSelection?: boolean;  // If true, clamp instead of preserving exact position
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

export type Suggestion = { key: string, text: string, component: React.ElementType };
export type SuggestionState = { suggestions: Suggestion[]; selected: number };

/** The (suggestions, selected) state after a request for `suggestions` lands. */
export function reduceSuggestions(
    prev: SuggestionState,
    suggestions: Suggestion[],
    { clampSelection, autoSelectFirst }: { clampSelection: boolean; autoSelectFirst: boolean },
): SuggestionState {
    if (clampSelection) {
        // Simply clamp the selection to valid range
        let newSelected = prev.selected;

        if (suggestions.length === 0) {
            newSelected = -1;
        } else if (autoSelectFirst && prev.suggestions.length === 0) {
            // First time showing suggestions, auto-select first
            newSelected = 0;
        } else if (prev.selected >= suggestions.length) {
            // Selection is out of bounds, clamp to last item
            newSelected = suggestions.length - 1;
        } else if (prev.selected < 0 && suggestions.length > 0 && autoSelectFirst) {
            // No selection but we have suggestions
            newSelected = 0;
        }

        return { suggestions, selected: newSelected };
    }

    // Try to preserve selection by key (old behavior)
    if (prev.selected >= 0 && prev.selected < prev.suggestions.length) {
        const previousKey = prev.suggestions[prev.selected].key;
        const newIndex = suggestions.findIndex(s => s.key === previousKey);
        if (newIndex !== -1) {
            // Found the same key, keep it selected
            return { suggestions, selected: newIndex };
        }
    }

    // Key not found or no previous selection, clamp the selection
    const clampedSelection = Math.min(prev.selected, suggestions.length - 1);
    return {
        suggestions,
        selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection,
    };
}

/**
 * The request worker for one handler. Each run is a generation on
 * `requestKey` across every worker the hook instance has owned, so a
 * superseded handler's late result (an @a request finishing after @b's) is
 * dropped instead of replacing the current suggestions (#249). `commit` only
 * ever sees the newest request's result.
 */
export function createSuggestionSync(
    requestKey: string,
    handler: (query: string) => Promise<Suggestion[]>,
    commit: (suggestions: Suggestion[]) => void,
): ValueSync<string | null> {
    return new ValueSync<string | null>(async (query) => {
        if (!query) {
            return;
        }
        const gen = nextGen(requestKey);
        const suggestions = await handler(query);
        if (!isLatest(requestKey, gen)) return;
        commit(suggestions);
    });
}

export function useActiveSuggestions(
    query: string | null, 
    handler: (query: string) => Promise<Suggestion[]>,
    options: SuggestionOptions = {}
) {
    const { 
        clampSelection = true, 
        autoSelectFirst = true,
        wrapAround = true 
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<SuggestionState>({
        suggestions: [],
        selected: -1
    });

    const moveUp = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected <= 0) {
                // At top or nothing selected
                if (wrapAround) {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                } else {
                    return { ...prev, selected: 0 };
                }
            }
            // Move up
            return { ...prev, selected: prev.selected - 1 };
        });
    }, [wrapAround]);

    const moveDown = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected >= prev.suggestions.length - 1) {
                // At bottom
                if (wrapAround) {
                    return { ...prev, selected: 0 };
                } else {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                }
            }
            // If nothing selected, select first
            if (prev.selected < 0) {
                return { ...prev, selected: 0 };
            }
            // Move down
            return { ...prev, selected: prev.selected + 1 };
        });
    }, [wrapAround]);

    // Sync query to suggestions. The worker lives in an effect, not a memo:
    // React's effect replay (StrictMode, Fast Refresh) runs the cleanup and
    // then the setup again on the SAME instance, so a memoized ValueSync
    // stopped by that cleanup stayed stopped for the life of the hook and
    // every later query was silently ignored (#249). Now the cleanup stops
    // the worker and the setup builds a fresh one.
    const requestKey = useLatestKey('suggestions');
    const syncRef = React.useRef<ValueSync<string | null> | null>(null);
    React.useEffect(() => {
        const sync = createSuggestionSync(requestKey, handler, (suggestions) => {
            setState((prev) => reduceSuggestions(prev, suggestions, { clampSelection, autoSelectFirst }));
        });
        syncRef.current = sync;
        return () => {
            sync.stop();
            retire(requestKey); // whatever this worker still has in flight must not land
            if (syncRef.current === sync) syncRef.current = null;
        };
    }, [clampSelection, autoSelectFirst, handler, requestKey]);
    React.useEffect(() => {
        // Ownership moves the moment the query or handler changes, not when
        // the serialized worker eventually runs the new value: an older
        // request still awaiting its handler is superseded right here.
        retire(requestKey);
        syncRef.current?.setValue(query);
    }, [query, clampSelection, autoSelectFirst, handler, requestKey]);

    // If no query return empty suggestions
    if (!query) {
        return [[], -1, moveUp, moveDown] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown] as const;
}