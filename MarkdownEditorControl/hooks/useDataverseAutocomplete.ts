import { useState, useCallback, useRef } from 'react';
import { Editor, editorViewCtx } from '@milkdown/core';
import type { DataverseMetadataFetcher } from '../types/editor.types';
import { handleError } from '../utils/errorHandler';

export interface AutocompletePosition {
    top: number;
    left: number;
}

export interface AutocompleteState {
    active: boolean;
    mode: 'entity' | 'attribute';
    query: string;
    entityName: string;
    suggestions: string[];
    selectedIndex: number;
    position: AutocompletePosition;
    loading: boolean;
}

export interface UseDataverseAutocompleteReturn {
    state: AutocompleteState;
    checkTrigger: () => void;
    handleKeyDown: (e: KeyboardEvent) => boolean;
    selectSuggestion: (suggestion: string) => void;
    close: () => void;
}

export interface UseDataverseAutocompleteProps {
    getEditor: () => Editor | undefined;
    containerRef: React.RefObject<HTMLDivElement | null>;
    metadataFetcher?: DataverseMetadataFetcher;
}

const INITIAL_STATE: AutocompleteState = {
    active: false,
    mode: 'entity',
    query: '',
    entityName: '',
    suggestions: [],
    selectedIndex: 0,
    position: { top: 0, left: 0 },
    loading: false,
};

const MAX_SUGGESTIONS = 50;

/**
 * Matches an open '#' reference trigger at the end of a string.
 * - Group 1: character preceding '#' (empty string when '#' is at the start)
 * - Group 2: entity logical name typed so far (may be empty)
 * - Group 3: attribute logical name typed so far — ONLY present when a '.' was typed
 *
 * The preceding character group ensures we don't match a *closing* '#' that
 * immediately follows alphanumeric content (e.g. the closing hash in `#account.name#`).
 */
const TRIGGER_PATTERN = /(^|[^a-zA-Z0-9_])#([a-zA-Z0-9_]*)(?:\.([a-zA-Z0-9_]*))?$/;

/** Return suggestions that start with query first, then those that merely contain it. */
function filterAndSort(list: string[], query: string): string[] {
    if (!list.length) return [];
    const q = query.toLowerCase();
    if (!q) return list.slice(0, MAX_SUGGESTIONS);

    const starts: string[] = [];
    const contains: string[] = [];
    for (const item of list) {
        const low = item.toLowerCase();
        if (starts.length + contains.length >= MAX_SUGGESTIONS) break;
        if (low.startsWith(q)) starts.push(item);
        else if (low.includes(q)) contains.push(item);
    }
    return [...starts, ...contains];
}

export function useDataverseAutocomplete({
    getEditor,
    containerRef,
    metadataFetcher,
}: UseDataverseAutocompleteProps): UseDataverseAutocompleteReturn {
    const [state, setState] = useState<AutocompleteState>(INITIAL_STATE);

    // Ref mirror so event-handler callbacks can read current state without a stale closure
    const stateRef = useRef<AutocompleteState>(INITIAL_STATE);
    stateRef.current = state;

    // Document position of the triggering '#' character in ProseMirror coords
    const triggerDocPosRef = useRef<number>(-1);

    // Metadata caches (populated lazily, never reset during a session)
    const entityListRef = useRef<string[] | null>(null);
    const entityLoadingRef = useRef<boolean>(false);
    const attrCacheRef = useRef<Map<string, string[]>>(new Map());
    const attrLoadingRef = useRef<Set<string>>(new Set());

    // -------------------------------------------------------------------------
    // close
    // -------------------------------------------------------------------------
    const close = useCallback(() => {
        triggerDocPosRef.current = -1;
        stateRef.current = { ...INITIAL_STATE };
        setState({ ...INITIAL_STATE });
    }, []);

    // -------------------------------------------------------------------------
    // checkTrigger  (call after every editor input event)
    // -------------------------------------------------------------------------
    const checkTrigger = useCallback(() => {
        if (!metadataFetcher) return;

        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            const { from, to } = view.state.selection;

            // Only autocomplete when there is no text selection
            if (from !== to) {
                if (stateRef.current.active) close();
                return;
            }

            const $from = view.state.doc.resolve(from);
            const blockStart = $from.start();

            if (from <= blockStart) {
                if (stateRef.current.active) close();
                return;
            }

            // Within a single block there are no block-boundary separators,
            // so each character index in the returned string maps 1-to-1 to
            // (blockStart + index) in ProseMirror document coordinates.
            const textInBlock = view.state.doc.textBetween(blockStart, from, '');

            const match = textInBlock.match(TRIGGER_PATTERN);
            if (!match) {
                if (stateRef.current.active) close();
                return;
            }

            const precCharLen = match[1].length; // 0 when '^' matched, 1 otherwise
            const hashOffset = match.index! + precCharLen;
            const triggerDocPos = blockStart + hashOffset;
            triggerDocPosRef.current = triggerDocPos;

            const entityPart = match[2]; // entity name so far (may be "")
            const attrPart = match[3];   // undefined → no dot yet; "" or "xyz" → dot was typed
            const hasDot = attrPart !== undefined;

            // '#.' with no entity name is not a valid trigger
            if (hasDot && entityPart === '') {
                if (stateRef.current.active) close();
                return;
            }

            const mode: 'entity' | 'attribute' = hasDot ? 'attribute' : 'entity';
            const query = hasDot ? (attrPart ?? '') : entityPart;

            // Dropdown position — placed just below the cursor
            let position = stateRef.current.active
                ? stateRef.current.position
                : { top: 0, left: 0 };
            if (containerRef.current) {
                try {
                    const coords = view.coordsAtPos(from);
                    const rect = containerRef.current.getBoundingClientRect();
                    position = {
                        top: coords.bottom - rect.top + 4,
                        left: Math.max(0, coords.left - rect.left),
                    };
                } catch { /* ignore position errors */ }
            }

            // Read from cache (may be empty if not loaded yet)
            const cachedList: string[] = mode === 'entity'
                ? (entityListRef.current ?? [])
                : (attrCacheRef.current.get(entityPart) ?? []);

            const isLoading = mode === 'entity'
                ? (entityListRef.current === null)
                : (!attrCacheRef.current.has(entityPart));

            const needsLoad = mode === 'entity'
                ? (entityListRef.current === null && !entityLoadingRef.current)
                : (!attrCacheRef.current.has(entityPart) && !attrLoadingRef.current.has(entityPart));

            const suggestions = filterAndSort(cachedList, query);

            // Reset selectedIndex when mode or entity changes
            const modeChanged = !stateRef.current.active
                || stateRef.current.mode !== mode
                || stateRef.current.entityName !== entityPart;
            const selectedIndex = modeChanged
                ? 0
                : Math.min(stateRef.current.selectedIndex, Math.max(0, suggestions.length - 1));

            const newState: AutocompleteState = {
                active: true,
                mode,
                query,
                entityName: entityPart,
                suggestions,
                selectedIndex,
                position,
                loading: isLoading,
            };
            stateRef.current = newState;
            setState(newState);

            if (needsLoad) {
                const snapshotTriggerPos = triggerDocPos;
                const snapshotQuery = query;

                if (mode === 'entity') {
                    entityLoadingRef.current = true;
                    metadataFetcher.getEntityNames()
                        .then(list => {
                            entityLoadingRef.current = false;
                            entityListRef.current = [...list].sort();

                            if (!stateRef.current.active || triggerDocPosRef.current !== snapshotTriggerPos) return undefined;
                            const newSugs = filterAndSort(entityListRef.current, snapshotQuery);
                            return setState(prev => prev.active ? {
                                ...prev,
                                suggestions: newSugs,
                                selectedIndex: Math.min(prev.selectedIndex, Math.max(0, newSugs.length - 1)),
                                loading: false,
                            } : prev);
                        })
                        .catch(() => {
                            entityLoadingRef.current = false;
                            entityListRef.current = [];
                            return setState(prev => prev.active ? { ...prev, loading: false, suggestions: [] } : prev);
                        });
                } else {
                    attrLoadingRef.current.add(entityPart);
                    const snapshotEntity = entityPart;
                    metadataFetcher.getAttributeNames(entityPart)
                        .then(list => {
                            attrLoadingRef.current.delete(snapshotEntity);
                            const sorted = [...list].sort();
                            attrCacheRef.current.set(snapshotEntity, sorted);

                            if (!stateRef.current.active || triggerDocPosRef.current !== snapshotTriggerPos) return undefined;
                            const newSugs = filterAndSort(sorted, snapshotQuery);
                            return setState(prev => prev.active ? {
                                ...prev,
                                suggestions: newSugs,
                                selectedIndex: Math.min(prev.selectedIndex, Math.max(0, newSugs.length - 1)),
                                loading: false,
                            } : prev);
                        })
                        .catch(() => {
                            attrLoadingRef.current.delete(entityPart);
                            attrCacheRef.current.set(entityPart, []);
                            return setState(prev => prev.active ? { ...prev, loading: false, suggestions: [] } : prev);
                        });
                }
            }
        } catch (err) {
            handleError(err, { component: 'useDataverseAutocomplete', action: 'checkTrigger' }, 'warning');
        }
    }, [getEditor, containerRef, metadataFetcher, close]);

    // -------------------------------------------------------------------------
    // selectSuggestion  (called when user clicks or presses Enter on an item)
    // -------------------------------------------------------------------------
    const selectSuggestion = useCallback((suggestion: string) => {
        const editor = getEditor();
        if (!editor) return;

        try {
            const view = editor.ctx.get(editorViewCtx);
            const triggerDocPos = triggerDocPosRef.current;
            if (triggerDocPos < 0) return;

            const { from } = view.state.selection;
            const $from = view.state.doc.resolve(from);
            const blockStart = $from.start();
            const textInBlock = view.state.doc.textBetween(blockStart, from, '');
            const match = textInBlock.match(TRIGGER_PATTERN);
            if (!match) return;

            const hasDot = match[3] !== undefined;
            const entityPart = match[2];

            // Entity selected → insert '#entity.' and stay in attribute mode
            // Attribute selected → insert '#entity.attr#' and close
            const newText = hasDot
                ? `#${entityPart}.${suggestion}#`
                : `#${suggestion}.`;

            const tr = view.state.tr.insertText(newText, triggerDocPos, from);
            view.dispatch(tr);
            view.focus();
        } catch (err) {
            handleError(err, { component: 'useDataverseAutocomplete', action: 'selectSuggestion' });
        }
    }, [getEditor]);

    // -------------------------------------------------------------------------
    // handleKeyDown  (returns true when the event was consumed)
    // -------------------------------------------------------------------------
    const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
        if (!stateRef.current.active) return false;

        const current = stateRef.current;

        switch (e.key) {
            case 'Escape':
                close();
                return true;

            case 'ArrowDown': {
                if (current.suggestions.length === 0) return true;
                const newIdx = Math.min(current.selectedIndex + 1, current.suggestions.length - 1);
                const next = { ...current, selectedIndex: newIdx };
                stateRef.current = next;
                setState(next);
                return true;
            }

            case 'ArrowUp': {
                if (current.suggestions.length === 0) return true;
                const newIdx = Math.max(current.selectedIndex - 1, 0);
                const next = { ...current, selectedIndex: newIdx };
                stateRef.current = next;
                setState(next);
                return true;
            }

            case 'Enter':
            case 'Tab': {
                if (current.suggestions.length > 0 && current.suggestions[current.selectedIndex]) {
                    selectSuggestion(current.suggestions[current.selectedIndex]);
                    return true;
                }
                return false;
            }

            default:
                return false;
        }
    }, [close, selectSuggestion]);

    return { state, checkTrigger, handleKeyDown, selectSuggestion, close };
}
