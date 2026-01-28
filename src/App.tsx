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

interface AppSettings {
	autoStart: boolean;
	shortcut: string;
}

function App() {
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [results, setResults] = useState<AppItem[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [isIndexing, setIsIndexing] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [settings, setSettings] = useState<AppSettings>({ autoStart: false, shortcut: 'Alt+S' });
	const [draftSettings, setDraftSettings] = useState<AppSettings>({ autoStart: false, shortcut: 'Alt+S' });
	const [settingsError, setSettingsError] = useState('');
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
			setShowSettings(false);
			setSettingsError('');
			setTimeout(() => inputRef.current?.focus(), 50);
		};

		const handleOpenSettings = () => {
			setShowSettings(true);
			setSettingsError('');
			window.ipcRenderer?.invoke('get-settings').then((s: AppSettings) => {
				if (s && typeof s === 'object') {
					setSettings(s);
					setDraftSettings(s);
				}
			});
		};

		window.ipcRenderer?.on('reset-search', handleReset);
		window.ipcRenderer?.on('open-settings', handleOpenSettings);

		window.ipcRenderer?.invoke('get-settings').then((s: AppSettings) => {
			if (s && typeof s === 'object') {
				setSettings(s);
				setDraftSettings(s);
			}
		});

		return () => {
			window.ipcRenderer?.removeAllListeners('reset-search');
			window.ipcRenderer?.removeAllListeners('open-settings');
		};
	}, []);

	useEffect(() => {
		if (showSettings) {
			window.ipcRenderer?.invoke('resize-window', 320);
			return;
		}

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
	}, [query, showSettings]);

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
			if (showSettings) {
				setShowSettings(false);
				setSettingsError('');
				setDraftSettings(settings);
				setTimeout(() => inputRef.current?.focus(), 50);
			} else {
				window.ipcRenderer?.invoke('hide-window');
			}
			return;
		}

		if (showSettings) return;
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

	const openSettings = async () => {
		setShowSettings(true);
		setSettingsError('');
		const s = (await window.ipcRenderer?.invoke('get-settings')) as AppSettings | undefined;
		if (s && typeof s === 'object') {
			setSettings(s);
			setDraftSettings(s);
		}
	};

	const normalizeKey = (key: string) => {
		if (!key) return '';
		if (key === ' ') return 'Space';
		if (key.length === 1) return key.toUpperCase();
		if (key === 'ArrowUp') return 'Up';
		if (key === 'ArrowDown') return 'Down';
		if (key === 'ArrowLeft') return 'Left';
		if (key === 'ArrowRight') return 'Right';
		return key;
	};

	const updateDraftSettings = (next: AppSettings) => {
		setDraftSettings(next);
		setSettingsError('');
	};

	const saveDraftSettings = async () => {
		setSettingsError('');
		const resp = (await window.ipcRenderer?.invoke('save-settings', draftSettings)) as
			| { ok: boolean; message?: string }
			| undefined;
		if (resp?.ok === false) {
			setSettingsError(resp.message || '设置保存失败');
			return;
		}
		setSettings(draftSettings);
		setShowSettings(false);
		setTimeout(() => inputRef.current?.focus(), 50);
	};

	const closeSettings = () => {
		setShowSettings(false);
		setSettingsError('');
		setDraftSettings(settings);
		setTimeout(() => inputRef.current?.focus(), 50);
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
			{!showSettings ? (
				<>
					<div className="search-box">
						<input
							ref={inputRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="输入文件名/路径（支持部分搜索）"
							autoFocus
						/>
						<button className="settings-btn" onClick={openSettings} title="设置" type="button">
							设置
						</button>
						<div className="drag-icon" title="按住拖拽移动" />
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
				</>
			) : (
				<div className="settings-panel" onKeyDown={handleKeyDown}>
					<div className="settings-header">
						<span className="settings-title">设置</span>
						<button className="close-settings" onClick={closeSettings} type="button" aria-label="关闭">
							×
						</button>
					</div>

					<div className="settings-content">
						<div className="settings-group">
							<div className="settings-group-title">启动</div>
							<label className="setting-row">
							<input
								type="checkbox"
								checked={draftSettings.autoStart}
								onChange={(e) => updateDraftSettings({ ...draftSettings, autoStart: e.target.checked })}
							/>
								<span>跟随此电脑启动自动运行</span>
							</label>
						</div>

						<div className="settings-group">
							<div className="settings-group-title">快捷键</div>
							<input
								className="shortcut-input"
								readOnly
								value={draftSettings.shortcut}
								placeholder="点击后按下组合键…"
								onKeyDown={(e) => {
									e.preventDefault();
									e.stopPropagation();

									const parts: string[] = [];
									if (e.ctrlKey) parts.push('CommandOrControl');
									if (e.altKey) parts.push('Alt');
									if (e.shiftKey) parts.push('Shift');
									if (e.metaKey) parts.push('Super');

									const mainKey = normalizeKey(e.key);
									if (!mainKey) return;
									if (['Control', 'Alt', 'Shift', 'Meta'].includes(mainKey)) return;

									parts.push(mainKey);
									const shortcut = parts.join('+');
									updateDraftSettings({ ...draftSettings, shortcut });
								}}
							/>
							{settingsError ? <div className="settings-error">{settingsError}</div> : null}
						</div>
					</div>

					<div className="settings-footer">
						<button className="settings-cancel" type="button" onClick={closeSettings}>
							取消
						</button>
						<button className="settings-confirm" type="button" onClick={saveDraftSettings}>
							确认
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export default App;
