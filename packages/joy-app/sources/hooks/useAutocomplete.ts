import * as React from 'react';
import { InvalidateSync } from '@/utils/sync';
import { createScope } from '@/utils/scope';

// Types
export interface AutocompleteResult {
    text: string;
}

export interface UseAutocompleteOptions {
    text: string;
    cursorPosition: number;
    autocompleteFunction: (text: string, cursorPosition: number) => Promise<AutocompleteResult[]>;
    debounceMs?: number;
}

export interface UseAutocompleteReturn {
    results: AutocompleteResult[];
    isLoading: boolean;
}

const emptyArray: AutocompleteResult[] = [];

export function useAutocomplete(query: string | null, resolver: (text: string) => Promise<AutocompleteResult[]>) {

    const [results, setResults] = React.useState<AutocompleteResult[]>([]);
    const resolverRef = React.useRef(resolver);
    resolverRef.current = resolver;
    const queryRef = React.useRef(query);
    queryRef.current = query;

    // The retry worker is owned by an effect scope: leaving the screen stops
    // it (its backoff used to keep calling a failing resolver forever, #309)
    // and a request already in flight publishes nothing after cleanup. An
    // effect replay creates a fresh, usable worker.
    const workerRef = React.useRef<{ onSearchQueryChange: (text: string | null) => void } | null>(null);
    React.useEffect(() => {
        const scope = createScope();
        const state = { query: queryRef.current };
        const cache = new Map<string, AutocompleteResult[]>();

        const sync = new InvalidateSync(async () => {
            const t = state.query;
            if (t === null) {
                if (!scope.cancelled) setResults(emptyArray);
                return;
            }
            let found = cache.get(t);
            if (found === undefined) {
                found = await resolverRef.current(t);
                cache.set(t, found);
            }
            if (!scope.cancelled && state.query === t) {
                setResults(found);
            }
        });
        scope.defer(() => sync.stop());

        workerRef.current = {
            onSearchQueryChange: (text) => {
                state.query = text;
                sync.invalidate();
            },
        };
        sync.invalidate();
        return () => {
            scope.cancel();
            workerRef.current = null;
        };
    }, []);

    // Trigger sync
    React.useEffect(() => {
        workerRef.current?.onSearchQueryChange(query);
    }, [query]);

    // Return empty array if no query
    if (query === null) {
        return emptyArray;
    } else {
        return results;
    }
}
