import { useEffect, useRef, useState } from 'react';
import { List } from 'react-window';
import './App.css';

interface AppItem {
	name: string;
	path: string;
	description?: string;
	icon?: string;
	type?: string;
}

interface SearchResponse {
	results: AppItem[];
	isIndexing: boolean;
}

function App() {
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [results, setResults] = useState<AppItem[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [isIndexing, setIsIndexing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<any>(null);

	const ITEM_HEIGHT = 52;
	const MAX_LIST_HEIGHT = 420;

	useEffect(() => {
		inputRef.current?.focus();

		const handleReset = () => {
			setQuery('');
			setResults([]);
			setIsSearching(false);
			setTimeout(() => inputRef.current?.focus(), 50);
		};

		window.ipcRenderer?.on('reset-search', handleReset);
		return () => {
			window.ipcRenderer?.removeAllListeners('reset-search');
		};
	}, []);

	useEffect(() => {
		if (!query) {
			setResults([]);
			setIsSearching(false);
			window.ipcRenderer?.invoke('resize-window', 68); // 8px padding * 2 + 52px input-box
			return;
		}

		const timer = setTimeout(async () => {
			if (query.length < 2) {
				setResults([]);
				setIsSearching(false);
				window.ipcRenderer?.invoke('resize-window', 68);
				return;
			}

			setIsSearching(true);
			window.ipcRenderer?.invoke('resize-window', 88); // input-box + status
			
			try {
				const resp = (await window.ipcRenderer?.invoke(
					'search-files',
					query
				)) as SearchResponse | undefined;
				const nextResults = resp?.results ?? [];
				setResults(nextResults);
				setSelectedIndex(0);
				setIsIndexing(Boolean(resp?.isIndexing));

				// Precise height calculation
				const containerPadding = 16; // 8px top + 8px bottom
				const searchBoxHeight = 52; // including margin-top 4px
				const statusHeight = (isSearching || resp?.isIndexing) ? 20 : 0;
				const listHeight = nextResults.length > 0 
					? Math.min(nextResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10 // 10px margin-top for .results
					: 0;
				
				window.ipcRenderer?.invoke(
					'resize-window',
					containerPadding + searchBoxHeight + statusHeight + listHeight
				);
			} finally {
				setIsSearching(false);
			}
		}, 250);

		return () => clearTimeout(timer);
	}, [query]);

	useEffect(() => {
		if (listRef.current) {
			listRef.current.scrollToRow({ index: selectedIndex, align: 'auto' });
		}
	}, [selectedIndex]);

	const launchApp = (app: AppItem) => {
		window.ipcRenderer?.invoke('open-app', app.path);
		setQuery('');
		setResults([]);
		setIsSearching(false);
	};

	const openFolder = (app: AppItem) => {
		window.ipcRenderer?.invoke('open-folder', app.path);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Escape') {
			window.ipcRenderer?.invoke('hide-window');
			return;
		}

		if (results.length === 0) return;

		if (e.key === 'ArrowDown') {
			setSelectedIndex((prev) => (prev + 1) % results.length);
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
			e.preventDefault();
		} else if (e.key === 'Enter') {
			launchApp(results[selectedIndex]);
		}
	};

	const statusText = isSearching
		? '正在搜索…'
		: isIndexing
			? '正在建立本地文件索引…'
			: '';

	const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
		const item = results[index];
		if (!item) return null;
		
		return (
			<div
				style={style}
				className={`result-item-wrapper ${index === selectedIndex ? 'selected' : ''}`}
				onClick={() => launchApp(item)}
			>
				<li className={index === selectedIndex ? 'selected' : ''}>
					{item.icon ? (
						<img className="result-icon" src={item.icon} alt="" />
					) : (
						<span className="result-icon placeholder" />
					)}
					<div className="result-meta">
						<span className="app-name">{item.name}</span>
						<span className="app-path" title={item.path}>
							{item.path}
						</span>
					</div>
					<div className="action-group">
						<button
							className="action-btn"
							onClick={(e) => {
								e.stopPropagation();
								openFolder(item);
							}}
							title="打开所在目录"
						>
							目录
						</button>
						<button
							className="action-btn"
							onClick={(e) => {
								e.stopPropagation();
								navigator.clipboard.writeText(item.path);
							}}
							title="复制路径"
						>
							复制
						</button>
					</div>
				</li>
			</div>
		);
	};

	const listHeight = Math.min(results.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);

	return (
		<div className="container">
			<div className="drag-handle" title="拖拽移动窗口" />
			<div className="search-box">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="输入文件名/路径（支持模糊）"
					autoFocus
				/>
			</div>

			{statusText && (
				<div className="status">
					<span className="spinner" />
					<span className="status-text">{statusText}</span>
				</div>
			)}

			{results.length > 0 && (
				<div className="results">
					<List<any>
						listRef={listRef}
						style={{ height: listHeight, width: '100%' }}
						rowCount={results.length}
						rowHeight={ITEM_HEIGHT}
						className="virtual-list"
						rowComponent={Row}
						rowProps={{}}
					/>
				</div>
			)}
		</div>
	);
}

export default App;
