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
    const queryRef = React.useRef(query);
    queryRef.current = query;
    const resolverRef = React.useRef(resolver);
    resolverRef.current = resolver;

    // The retry worker is owned by an effect scope: leaving the screen stops
    // it (its backoff used to keep calling a failing resolver forever, #309)
    // and a request already in flight publishes nothing after cleanup. An
    // effect replay creates a fresh, usable worker.
    //
    // The resolver is part of the worker's STATE, not captured at mount: a
    // caller swapping resolvers (another session's commands/files) used to
    // keep getting the first session's suggestions, and a cache keyed only
    // by query text handed back stale entries after the swap (#308). On a
    // resolver change the cache is dropped, the current query re-runs, and
    // a lookup still in flight on the OLD resolver publishes nothing.
    type Resolver = (text: string) => Promise<AutocompleteResult[]>;
    const workerRef = React.useRef<{
        onSearchQueryChange: (text: string | null) => void;
        onResolverChange: (resolver: Resolver) => void;
    } | null>(null);
    React.useEffect(() => {
        const scope = createScope();
        const state = { query: queryRef.current, resolver: resolverRef.current, cache: new Map<string, AutocompleteResult[]>() };

        const sync = new InvalidateSync(async () => {
            const t = state.query;
            const resolve = state.resolver;
            const cache = state.cache;
            if (t === null) {
                if (!scope.cancelled) setResults(emptyArray);
                return;
            }
            let found = cache.get(t);
            if (found === undefined) {
                found = await resolve(t);
                // A resolver swap mid-flight: this answer belongs to the
                // previous context — neither cache nor publish it.
                if (state.resolver !== resolve) return;
                cache.set(t, found);
            }
            if (!scope.cancelled && state.query === t && state.resolver === resolve) {
                setResults(found);
            }
        });
        scope.defer(() => sync.stop());

        workerRef.current = {
            onSearchQueryChange: (text) => {
                state.query = text;
                sync.invalidate();
            },
            onResolverChange: (resolver) => {
                if (state.resolver === resolver) return;
                state.resolver = resolver;
                state.cache = new Map();
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
    React.useEffect(() => {
        workerRef.current?.onResolverChange(resolver);
    }, [resolver]);

    // Return empty array if no query
    if (query === null) {
        return emptyArray;
    } else {
        return results;
    }
}
