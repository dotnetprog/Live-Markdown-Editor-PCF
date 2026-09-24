import * as React from 'react';
import { useEffect, useRef } from 'react';
import type { AutocompleteState } from '../hooks/useDataverseAutocomplete';

export interface DataverseAutocompleteProps {
    state: AutocompleteState;
    onSelect: (suggestion: string) => void;
    onClose: () => void;
    theme: 'light' | 'dark' | 'high-contrast';
}

export const DataverseAutocomplete: React.FC<DataverseAutocompleteProps> = ({
    state,
    onSelect,
    theme,
}) => {
    const listRef = useRef<HTMLUListElement>(null);
    const { active, mode, query, entityName, suggestions, selectedIndex, position, loading } = state;

    // Hooks must be called unconditionally (before any early return)
    // Auto-scroll the highlighted item into view whenever selectedIndex changes
    useEffect(() => {
        if (!active) return;
        const list = listRef.current;
        if (!list) return;
        const item = list.children[selectedIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: 'nearest' });
    }, [active, selectedIndex]);

    if (!active) return null;

    const headerText = mode === 'entity'
        ? 'Entity name'
        : `Attributes of ${entityName}`;

    const handleMouseDown = (e: React.MouseEvent, suggestion: string) => {
        // mousedown fires before blur; prevent the editor losing focus first
        e.preventDefault();
        onSelect(suggestion);
    };

    return (
        <div
            className={`dv-autocomplete ${theme}`}
            style={{ top: position.top, left: position.left }}
            role="listbox"
            aria-label="Dataverse reference suggestions"
        >
            <div className="dv-autocomplete-header">
                <span className="dv-autocomplete-header-text">{headerText}</span>
                <span className="dv-autocomplete-hint">↑↓ · Enter · Esc</span>
            </div>

            {loading ? (
                <div className="dv-autocomplete-status">Loading…</div>
            ) : suggestions.length === 0 ? (
                <div className="dv-autocomplete-status">
                    {query ? `No matches for "${query}"` : 'No suggestions available'}
                </div>
            ) : (
                <ul ref={listRef} className="dv-autocomplete-list">
                    {suggestions.map((suggestion, index) => (
                        <li
                            key={suggestion}
                            role="option"
                            aria-selected={index === selectedIndex}
                            className={`dv-autocomplete-item${index === selectedIndex ? ' selected' : ''}`}
                            onMouseDown={(e) => handleMouseDown(e, suggestion)}
                        >
                            {highlightMatch(suggestion, query)}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

/** Wrap the matched portion of `text` in a <mark> element. */
function highlightMatch(text: string, query: string): React.ReactNode {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
        <>
            {text.slice(0, idx)}
            <mark className="dv-autocomplete-mark">{text.slice(idx, idx + query.length)}</mark>
            {text.slice(idx + query.length)}
        </>
    );
}
