import React, { useState, useEffect, useRef } from 'react';
import { 
  Download, Trash2, FileDown, 
  Activity, Wifi, WifiOff, Search, ExternalLink, 
  AlertTriangle, Loader2, CheckCircle2, Ban, History, RotateCcw,
  Terminal, Settings, ChevronDown, ChevronUp, Cpu, Server
} from 'lucide-react';

interface Format {
  format_id: string;
  ext: string;
  resolution: string;
  filesize: number;
  fps: number | null;
  vcodec: string;
  acodec: string;
  type: 'video_only' | 'audio_only' | 'video_and_audio';
  format_note?: string;
}

interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  description: string;
  duration: number;
  uploader: string;
  view_count: number;
  upload_date: string;
  webpage_url: string;
  formats: Format[];
}

interface Task {
  id: string;
  url: string;
  title: string;
  status: 'pending' | 'downloading' | 'processing' | 'finished' | 'cancelled' | 'error' | 'cancelling';
  percent: number;
  speed: number;
  eta: number;
  filename: string;
  error?: string;
  cancel_requested: boolean;
  logs?: string[];
}

interface SystemStatus {
  ffmpeg_installed: boolean;
  downloads_directory: string;
  platform: string;
}

interface HistoryItem {
  id: string;
  title: string;
  url: string;
  filename: string;
  timestamp: number;
  status: 'success' | 'error';
  errorMessage?: string;
}

const PLATFORM_EXAMPLES: Record<string, string> = {
  'YouTube': 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'TikTok': 'https://www.tiktok.com/@scout2015/video/6986111128326081797',
  'Twitter / X': 'https://twitter.com/NASA/status/1715456487192686835',
  'Instagram': 'https://www.instagram.com/p/CGy43z1g6b7/',
  'Twitch': 'https://www.twitch.tv/videos/1234567890',
  'SoundCloud': 'https://soundcloud.com/octobersveryown/drake-back-to-back',
  'Vimeo': 'https://vimeo.com/22439234',
  'Reddit': 'https://www.reddit.com/r/pics/comments/16lshqy/an_editorial_cartoon_from_the_1930s/',
  'Bandcamp': 'https://tycho.bandcamp.com/track/awake',
  'Facebook': 'https://www.facebook.com/NASA/videos/10155490799796772/',
  'Bilibili': 'https://www.bilibili.com/video/BV11S4y1k7a1',
  'Spotify': 'https://open.spotify.com/track/4PTG3Z6ehGkBF3zI7Y1wL3',
  'Dailymotion': 'https://www.dailymotion.com/video/x8n6z9g',
};

const getApiUrl = (path: string) => {
  const base = (import.meta.env.VITE_API_URL as string) || '';
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
};

const getWsUrl = () => {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  if (base) {
    const wsProtocol = base.startsWith('https:') ? 'wss:' : 'ws:';
    const cleanUrl = base.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `${wsProtocol}//${cleanUrl}/api/ws/tasks`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws/tasks`;
};

export default function App() {
  // State
  const [url, setUrl] = useState('');
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [infoError, setInfoError] = useState('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  
  const [tasks, setTasks] = useState<Task[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  
  // WS connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Download History
  const [downloadHistory, setDownloadHistory] = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('aeroytdl_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Download Form Options
  const [activeTab, setActiveTab] = useState<'best' | 'custom' | 'audio_only'>('best');
  const [selectedFormatId, setSelectedFormatId] = useState<string>('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [audioQuality, setAudioQuality] = useState('192');
  const [embedThumbnail, setEmbedThumbnail] = useState(false);
  const [embedMetadata, setEmbedMetadata] = useState(false);
  const [customName, setCustomName] = useState('');
  const [isStartingDownload, setIsStartingDownload] = useState(false);

  // Advanced Form Controls
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [speedLimit, setSpeedLimit] = useState('none');
  const [writeSubs, setWriteSubs] = useState(false);
  const [cookiesFromBrowser, setCookiesFromBrowser] = useState('none');
  const [proxy, setProxy] = useState('');

  // Cookies Modal State
  const [showCookiesModal, setShowCookiesModal] = useState(false);
  const [rawCookieText, setRawCookieText] = useState('');
  const [isSavingCookies, setIsSavingCookies] = useState(false);
  const [cookiesError, setCookiesError] = useState('');

  // UI state for task logs
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});

  const toggleLogs = (taskId: string) => {
    setExpandedLogs(prev => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  const wsRef = useRef<WebSocket | null>(null);
  const triggeredDownloads = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem('aeroytdl_history', JSON.stringify(downloadHistory));
    } catch (e) {
      console.error("Failed to save history", e);
    }
  }, [downloadHistory]);

  // Initialize
  useEffect(() => {
    fetchSystemStatus();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Fetch API Functions
  const fetchSystemStatus = async () => {
    try {
      const res = await fetch(getApiUrl('/api/status'));
      if (res.ok) {
        const data = await res.json();
        setSystemStatus(data);
      }
    } catch (e) {
      console.error("Failed to fetch system status", e);
    }
  };

  const connectWebSocket = () => {
    const wsUrl = getWsUrl();
    
    console.log("Connecting WebSocket to", wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      console.log("WebSocket connected");
    };

    ws.onclose = () => {
      setWsConnected(false);
      console.log("WebSocket disconnected. Retrying in 3 seconds...");
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (e) => {
      console.error("WebSocket error", e);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'tasks_list') {
          setTasks(data.tasks);
        } else if (data.type === 'task_update') {
          const updatedTask = data.task;
          const taskId = data.task_id;

          if (updatedTask.status === 'deleted') {
            setTasks(prev => prev.filter(t => t.id !== taskId));
            return;
          }

          setTasks(prev => {
            const idx = prev.findIndex(t => t.id === taskId);
            if (idx === -1) {
              return [updatedTask, ...prev];
            } else {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], ...updatedTask };
              return updated;
            }
          });

          // Handle completed/failed side effects outside of the react state updater
          if (updatedTask.status === 'finished' && !triggeredDownloads.current.has(taskId)) {
            triggeredDownloads.current.add(taskId);

            // Add to download history
            setDownloadHistory(h => {
              if (h.some(item => item.id === taskId)) return h;
              return [
                {
                  id: taskId,
                  title: updatedTask.title,
                  url: updatedTask.url,
                  filename: updatedTask.filename,
                  timestamp: Date.now() / 1000,
                  status: 'success' as const
                },
                ...h
              ].slice(0, 50);
            });

            // The file is ready on the server. The user will click "Save File" to download it.
          } else if (updatedTask.status === 'error' && !triggeredDownloads.current.has(taskId)) {
            triggeredDownloads.current.add(taskId);

            // Add failed download to history
            setDownloadHistory(h => {
              if (h.some(item => item.id === taskId)) return h;
              return [
                {
                  id: taskId,
                  title: updatedTask.title,
                  url: updatedTask.url,
                  filename: '',
                  timestamp: Date.now() / 1000,
                  status: 'error' as const,
                  errorMessage: updatedTask.error
                },
                ...h
              ].slice(0, 50);
            });
          }
        }
      } catch (err) {
        console.error("Failed to parse WS message", err);
      }
    };
  };

  const triggerAnalysis = async (targetUrl: string) => {
    if (!targetUrl.trim()) return;
    setLoadingInfo(true);
    setInfoError('');
    setVideoInfo(null);
    setSelectedFormatId('');

    try {
      const cookiesParam = cookiesFromBrowser !== 'none' ? `&cookies_from_browser=${cookiesFromBrowser}` : '';
      const proxyParam = proxy.trim() ? `&proxy=${encodeURIComponent(proxy.trim())}` : '';
      const res = await fetch(getApiUrl(`/api/info?url=${encodeURIComponent(targetUrl)}${cookiesParam}${proxyParam}`));
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to analyze video info");
      }
      const data = await res.json();
      setVideoInfo(data);
      
      // Default tab is Best Quality — auto-merge, no format_id needed.
      // For Custom tab, pre-select first video format.
      if (data.formats && data.formats.length > 0) {
        const firstVideo = data.formats.find((f: Format) => f.type === 'video_only') || data.formats[0];
        setSelectedFormatId(firstVideo?.format_id || '');
      }
      setActiveTab('best');
    } catch (err: any) {
      setInfoError(err.message || "An error occurred");
    } finally {
      setLoadingInfo(false);
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    triggerAnalysis(url);
  };

  const handleDownload = async () => {
    if (!videoInfo) return;

    setIsStartingDownload(true);
    try {
      const isAudioOnly = activeTab === 'audio_only';
      const body: any = {
        url: videoInfo.webpage_url || url,
        audio_only: isAudioOnly,
        custom_name: customName.trim() || null
      };

      if (isAudioOnly) {
        body.audio_format = audioFormat;
        body.audio_quality = audioQuality;
      } else {
        // 'best' tab sends no format_id → backend uses bestvideo*+bestaudio (FFmpeg merge)
        body.format_id = activeTab === 'best' ? null : selectedFormatId;
        body.embed_thumbnail = embedThumbnail;
        body.embed_metadata = embedMetadata;
      }

      // Add advanced options to request body
      body.speed_limit = speedLimit === 'none' ? null : speedLimit;
      body.write_subs = writeSubs;
      body.cookies_from_browser = cookiesFromBrowser === 'none' ? null : cookiesFromBrowser;
      body.proxy = proxy.trim() || null;

      const res = await fetch(getApiUrl('/api/download'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to start download");
      }

      // Reset state on success
      setCustomName('');
      setVideoInfo(null);
      setUrl('');
      
    } catch (e: any) {
      alert(e.message || "Failed to start download");
    } finally {
      setIsStartingDownload(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    try {
      await fetch(getApiUrl(`/api/tasks/${taskId}/cancel`), { method: 'POST' });
    } catch (e) {
      console.error("Failed to cancel task", e);
    }
  };

  const handleSaveCookies = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawCookieText.trim()) return;
    setIsSavingCookies(true);
    setCookiesError('');

    try {
      const res = await fetch(getApiUrl('/api/cookies'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: rawCookieText })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to save cookies');
      }

      setShowCookiesModal(false);
      setRawCookieText('');
      fetchSystemStatus(); // Refresh cookies_configured status
      setCookiesFromBrowser('cookies.txt'); // Automatically switch to cookies.txt
      alert('Cookies saved and configured successfully! Switched active cookies to cookies.txt.');
    } catch (err: any) {
      setCookiesError(err.message || 'An error occurred');
    } finally {
      setIsSavingCookies(false);
    }
  };

  // Helper formatting
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (!bytesPerSec) return '0 B/s';
    return `${formatBytes(bytesPerSec)}/s`;
  };

  const formatDuration = (seconds: number) => {
    if (!seconds) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatETA = (seconds: number) => {
    if (seconds === null || seconds === undefined) return 'Unknown';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-container">
          <span className="logo-icon">🚀</span>
          <div>
            <h1 className="logo-text">AeroYTDL</h1>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'var(--font-family-mono)' }}>
              v2026.05.24 // Premium Media Archiver
            </span>
          </div>
        </div>
        
        <div className="system-status" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {/* Platform Info */}
          {systemStatus && (
            <div className="status-badge" style={{ gap: '0.35rem' }}>
              <Cpu size={14} style={{ color: 'var(--text-muted)' }} />
              <span>OS: {systemStatus.platform.toUpperCase()}</span>
            </div>
          )}

          {/* Active Queues Counter */}
          <div className="status-badge" style={{ gap: '0.35rem' }}>
            <Server size={14} style={{ color: 'var(--text-muted)' }} />
            <span>QUEUES: {tasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'processing').length} active</span>
          </div>

          {/* Local History Size */}
          <div className="status-badge" style={{ gap: '0.35rem' }}>
            <History size={14} style={{ color: 'var(--text-muted)' }} />
            <span>HISTORY: {downloadHistory.length} saved</span>
          </div>

          {/* WebSocket status */}
          <div className="status-badge" style={{
            borderColor: wsConnected ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)',
            background: wsConnected ? 'rgba(16,185,129,0.03)' : 'rgba(244,63,94,0.03)'
          }}>
            {wsConnected ? (
              <Wifi className="status-indicator active" size={14} style={{ color: 'var(--success)' }} />
            ) : (
              <WifiOff className="status-indicator inactive" size={14} style={{ color: 'var(--error)' }} />
            )}
            <span style={{ color: wsConnected ? 'var(--success)' : 'var(--error)' }}>
              WS: {wsConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
          
          {/* FFmpeg status */}
          {systemStatus && (
            <div className="status-badge" style={{
              borderColor: systemStatus.ffmpeg_installed ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)',
              background: systemStatus.ffmpeg_installed ? 'rgba(16,185,129,0.03)' : 'rgba(245,158,11,0.03)'
            }}>
              <div className={`status-indicator ${systemStatus.ffmpeg_installed ? 'active' : 'inactive'}`} style={{
                background: systemStatus.ffmpeg_installed ? 'var(--success)' : 'var(--warning)',
                boxShadow: systemStatus.ffmpeg_installed ? '0 0 10px var(--success-glow)' : '0 0 10px rgba(245,158,11,0.2)'
              }} />
              <span style={{ color: systemStatus.ffmpeg_installed ? 'var(--success)' : 'var(--warning)' }}>
                FFMPEG: {systemStatus.ffmpeg_installed ? 'ACTIVE' : 'DISABLED'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* FFmpeg Alert Warning */}
      {systemStatus && !systemStatus.ffmpeg_installed && (
        <div className="glass-card" style={{ padding: '1rem 1.5rem', borderLeft: '4px solid var(--warning)', display: 'flex', alignItems: 'center', gap: '1rem', animation: 'fadeIn 0.3s ease' }}>
          <AlertTriangle style={{ color: 'var(--warning)', flexShrink: 0 }} size={24} />
          <div style={{ fontSize: '0.9rem' }}>
            <span style={{ fontWeight: 'bold', color: 'var(--text-main)' }}>FFmpeg is not installed on this system.</span> Audio format conversion (e.g. exporting to MP3) and post-processing merges (e.g. assembling high-res video formats) will be disabled. Download will fallback to native formats.
          </div>
        </div>
      )}

      {/* Downloader Section */}
      <section className="glass-card downloader-box animate-fade-in">
        <h2 style={{ fontSize: '1.4rem', fontWeight: 600 }}>Paste Any Link — 1000+ Platforms Supported</h2>

        {/* Supported Platforms Grid */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', paddingBottom: '0.5rem' }}>
          {[
            { icon: '▶️', name: 'YouTube' },
            { icon: '🎵', name: 'TikTok' },
            { icon: '🐦', name: 'Twitter / X' },
            { icon: '📸', name: 'Instagram' },
            { icon: '🎮', name: 'Twitch' },
            { icon: '☁️', name: 'SoundCloud' },
            { icon: '🎬', name: 'Vimeo' },
            { icon: '🤖', name: 'Reddit' },
            { icon: '🎸', name: 'Bandcamp' },
            { icon: '📘', name: 'Facebook' },
            { icon: '📺', name: 'Bilibili' },
            { icon: '🎙️', name: 'Spotify' },
            { icon: '🎥', name: 'Dailymotion' },
            { icon: '🔵', name: 'LinkedIn' },
          ].map(p => {
            const hasExample = p.name in PLATFORM_EXAMPLES;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => hasExample && triggerAnalysis(PLATFORM_EXAMPLES[p.name])}
                title={hasExample ? `Click to auto-load and analyze a demo ${p.name} link!` : "1000+ sites supported natively"}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.76rem',
                  padding: '0.3rem 0.75rem',
                  background: hasExample ? 'rgba(139, 92, 246, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  border: hasExample ? '1px solid rgba(139, 92, 246, 0.2)' : '1px solid rgba(255, 255, 255, 0.05)',
                  borderRadius: 'var(--radius-full)',
                  color: hasExample ? 'var(--primary-light)' : 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                  cursor: hasExample ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                  outline: 'none',
                }}
                className={hasExample ? "interactive-badge" : ""}
              >
                <span>{p.icon}</span> {p.name}
              </button>
            );
          })}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            fontSize: '0.76rem',
            padding: '0.3rem 0.75rem',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            borderRadius: 'var(--radius-full)',
            color: 'var(--text-muted)',
            whiteSpace: 'nowrap',
          }}>
            📡 1000+ more...
          </span>
        </div>

        <form onSubmit={handleAnalyze} className="input-group">
          <input 
            type="text" 
            placeholder="Paste any URL — YouTube, TikTok, Twitter/X, Instagram, Twitch, Reddit, Vimeo..."
            className="url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loadingInfo}
          />
          <button type="submit" className="btn btn-primary" disabled={loadingInfo}>
            {loadingInfo ? (
              <>
                <Loader2 className="spinner" size={18} />
                Analyzing...
              </>
            ) : (
              <>
                <Search size={18} />
                Analyze Link
              </>
            )}
          </button>
        </form>

        {/* Collapsible Advanced Options Toggle */}
        <div style={{ marginTop: '0.2rem', borderBottom: showAdvanced ? '1px dashed var(--border-color)' : 'none', paddingBottom: showAdvanced ? '1rem' : '0' }}>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: 'pointer',
              padding: '0.5rem 0',
              outline: 'none',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Settings size={15} />
              Advanced Connection & Extraction Controls (Cookies, Proxy, Speed)
            </span>
            {showAdvanced ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>

          {showAdvanced && (
            <div className="config-grid animate-fade-in" style={{ marginTop: '0.75rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '1rem', gap: '1rem' }}>
              {/* Speed limit option */}
              <div>
                <label className="form-label">Bandwidth Throttle</label>
                <select
                  className="select-control"
                  value={speedLimit}
                  onChange={(e) => setSpeedLimit(e.target.value)}
                >
                  <option value="none">No Limit (Uncapped)</option>
                  <option value="500K">500 KB/s</option>
                  <option value="1M">1 MB/s (Slow)</option>
                  <option value="5M">5 MB/s (Standard)</option>
                  <option value="10M">10 MB/s (Fast)</option>
                </select>
              </div>

              {/* Cookie source option */}
              <div>
                <label className="form-label">Extract Cookies From Browser</label>
                <select
                  className="select-control"
                  value={cookiesFromBrowser}
                  onChange={(e) => setCookiesFromBrowser(e.target.value)}
                  title="Helpful for age-restricted videos or videos that require login/bypass bot checks"
                >
                  <option value="none">Disabled (No Cookies)</option>
                  <option value="cookies.txt">cookies.txt (Loaded from backend/cookies.txt)</option>
                  <option value="chrome">Google Chrome</option>
                  <option value="firefox">Mozilla Firefox</option>
                  <option value="edge">Microsoft Edge</option>
                  <option value="brave">Brave Browser</option>
                  <option value="opera">Opera</option>
                </select>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.45rem' }}>
                  <span style={{ fontSize: '0.74rem', color: systemStatus?.cookies_configured ? 'var(--success)' : 'var(--text-muted)', fontFamily: 'var(--font-family-mono)' }}>
                    {systemStatus?.cookies_configured ? '● cookies.txt CONFIGURED' : '○ cookies.txt NOT FOUND'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowCookiesModal(true)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--primary-light)',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      padding: 0,
                      textDecoration: 'underline',
                      outline: 'none',
                    }}
                  >
                    Paste cookies.txt content
                  </button>
                </div>
              </div>

              {/* Subtitle track options */}
              <div>
                <label className="form-label">Subtitle Track Options</label>
                <div className="checkbox-group" style={{ padding: '0.45rem 0' }}>
                  <label className="checkbox-label" style={{ fontSize: '0.82rem' }}>
                    <input
                      type="checkbox"
                      className="checkbox-input"
                      checked={writeSubs}
                      onChange={(e) => setWriteSubs(e.target.checked)}
                    />
                    Download & Embed Subtitles
                  </label>
                </div>
              </div>

              {/* Custom Proxy Server */}
              <div>
                <label className="form-label">Custom Network Proxy</label>
                <input
                  type="text"
                  placeholder="e.g. http://127.0.0.1:8080"
                  className="select-control"
                  style={{ padding: '0.52rem 1rem' }}
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {infoError && (
          <div style={{ color: 'var(--error)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <AlertTriangle size={16} />
            <span>{infoError}</span>
          </div>
        )}

        {/* Video Info Dashboard Card */}
        {videoInfo && (
          <div className="glass-card animate-fade-in" style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginTop: '1rem' }}>
            <div className="video-info-grid">
              {/* Thumbnail col */}
              <div>
                <div className="video-thumbnail-container">
                  <img src={videoInfo.thumbnail} alt={videoInfo.title} className="video-thumbnail" />
                  <span className="video-duration">{formatDuration(videoInfo.duration)}</span>
                </div>
                
                {/* External link */}
                <a 
                  href={videoInfo.webpage_url} 
                  target="_blank" 
                  rel="noreferrer" 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary-light)', fontSize: '0.82rem', marginTop: '0.8rem', textDecoration: 'none', justifyContent: 'center' }}
                >
                  View Source Platform <ExternalLink size={12} />
                </a>
              </div>

              {/* Details and Download Options col */}
              <div className="video-details">
                <div>
                  <h3 className="video-title">{videoInfo.title}</h3>
                  <div className="video-meta-inline" style={{ marginTop: '0.5rem' }}>
                    <div className="video-meta-item">
                      <span>By:</span> <strong style={{ color: 'var(--text-main)' }}>{videoInfo.uploader}</strong>
                    </div>
                    {videoInfo.view_count !== null && (
                      <div className="video-meta-item">
                        <span>Views:</span> <strong style={{ color: 'var(--text-main)' }}>{videoInfo.view_count.toLocaleString()}</strong>
                      </div>
                    )}
                    {videoInfo.upload_date && (
                      <div className="video-meta-item">
                        <span>Uploaded:</span> <strong style={{ color: 'var(--text-main)' }}>{
                          videoInfo.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
                        }</strong>
                      </div>
                    )}
                  </div>
                </div>

                {/* Tabs for formats */}
                <div className="options-wrapper">
                  <div className="tabs-container">
                    <button
                      type="button"
                      className={`tab ${activeTab === 'best' ? 'active' : ''}`}
                      onClick={() => setActiveTab('best')}
                    >
                      🏆 Best Quality (Auto)
                    </button>
                    <button
                      type="button"
                      className={`tab ${activeTab === 'custom' ? 'active' : ''}`}
                      onClick={() => {
                        setActiveTab('custom');
                        const f = videoInfo.formats.find(f => f.type === 'video_only') ||
                                  videoInfo.formats.find(f => f.type === 'video_and_audio') ||
                                  videoInfo.formats[0];
                        setSelectedFormatId(f?.format_id || '');
                      }}
                    >
                      🎬 Custom Resolution
                    </button>
                    <button
                      type="button"
                      className={`tab ${activeTab === 'audio_only' ? 'active' : ''}`}
                      onClick={() => setActiveTab('audio_only')}
                    >
                      🎵 Audio Only
                    </button>
                  </div>

                  {/* Best Quality explanation card */}
                  {activeTab === 'best' && (
                    <div style={{
                      background: 'linear-gradient(135deg, rgba(139,92,246,0.12), rgba(16,185,129,0.06))',
                      border: '1px solid rgba(139,92,246,0.25)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.85rem 1.1rem',
                      fontSize: '0.88rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.3rem'
                    }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>🏆 Best Quality — FFmpeg Auto-Merge</span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Downloads the highest available resolution (up to 8K) + best audio, then merges them automatically using FFmpeg.
                        This is the recommended mode — quality is always maxed out.
                      </span>
                      {!systemStatus?.ffmpeg_installed && (
                        <span style={{ color: 'var(--warning)', fontSize: '0.82rem', marginTop: '0.2rem' }}>
                          ⚠️ FFmpeg is not detected — merge will be skipped and quality will be limited.
                        </span>
                      )}
                    </div>
                  )}

                  {/* Form Qualities (Custom Resolution only) */}
                  <div className="config-grid">
                    {activeTab === 'custom' && (
                      <div>
                        <label className="form-label">Pick Exact Format</label>
                        <select
                          className="select-control"
                          value={selectedFormatId}
                          onChange={(e) => setSelectedFormatId(e.target.value)}
                        >
                          <optgroup label="── Video + Audio (progressive, max ~720p) ──">
                            {videoInfo.formats
                              .filter(f => f.type === 'video_and_audio')
                              .map(f => (
                                <option key={f.format_id} value={f.format_id}>
                                  {f.resolution} · {f.ext} · {f.filesize > 0 ? formatBytes(f.filesize) : 'size unknown'}
                                </option>
                              ))
                            }
                          </optgroup>
                          <optgroup label="── Video Only DASH (requires FFmpeg merge) ──">
                            {videoInfo.formats
                              .filter(f => f.type === 'video_only')
                              .map(f => (
                                <option key={f.format_id} value={f.format_id}>
                                  {f.resolution}{f.fps ? `@${f.fps}fps` : ''} · {f.ext} · {f.filesize > 0 ? formatBytes(f.filesize) : 'size unknown'} {f.format_note ? `· ${f.format_note}` : ''}
                                </option>
                              ))
                            }
                          </optgroup>
                        </select>
                        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                          💡 "Video Only" DASH streams will be auto-merged with best audio via FFmpeg when downloaded.
                        </p>
                      </div>
                    )}

                    {/* Audio extractor qualities selector */}
                    {activeTab === 'audio_only' && (
                      <>
                        <div>
                          <label className="form-label">Audio Format</label>
                          <select 
                            className="select-control"
                            value={audioFormat}
                            onChange={(e) => setAudioFormat(e.target.value)}
                            disabled={systemStatus ? !systemStatus.ffmpeg_installed : false}
                          >
                            <option value="mp3">MP3 (.mp3)</option>
                            <option value="m4a">M4A (.m4a)</option>
                            <option value="wav">WAV (.wav)</option>
                            <option value="flac">FLAC (.flac)</option>
                            <option value="opus">Opus (.opus)</option>
                          </select>
                        </div>
                        <div>
                          <label className="form-label">Quality (Bitrate)</label>
                          <select 
                            className="select-control"
                            value={audioQuality}
                            onChange={(e) => setAudioQuality(e.target.value)}
                            disabled={audioFormat === 'wav' || audioFormat === 'flac' || (systemStatus ? !systemStatus.ffmpeg_installed : false)}
                          >
                            <option value="320">320 kbps (High Quality)</option>
                            <option value="256">256 kbps</option>
                            <option value="192">192 kbps (Standard)</option>
                            <option value="128">128 kbps (Low Quality)</option>
                          </select>
                        </div>
                      </>
                    )}

                    {/* Custom filename option */}
                    <div>
                      <label className="form-label">Rename Output File (Optional)</label>
                      <input 
                        type="text" 
                        placeholder="e.g. MyFavoriteSong"
                        className="select-control"
                        style={{ padding: '0.52rem 1rem' }}
                        value={customName}
                        onChange={(e) => setCustomName(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Checkboxes (Only for Video modes and requires FFmpeg) */}
                  {activeTab !== 'audio_only' && systemStatus?.ffmpeg_installed && (
                    <div className="checkbox-group">
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={embedThumbnail}
                          onChange={(e) => setEmbedThumbnail(e.target.checked)}
                        />
                        Embed Thumbnail
                      </label>
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={embedMetadata}
                          onChange={(e) => setEmbedMetadata(e.target.checked)}
                        />
                        Embed Metadata
                      </label>
                    </div>
                  )}
                  {/* Start Download button */}
                  <div style={{ marginTop: '0.5rem' }}>
                    <button 
                      type="button" 
                      className="btn btn-primary"
                      style={{ padding: '1rem 2.5rem', width: '100%' }}
                      onClick={handleDownload}
                      disabled={isStartingDownload}
                    >
                      {isStartingDownload ? (
                        <>
                          <Loader2 className="spinner" size={20} />
                          Initializing Download Task...
                        </>
                      ) : (
                        <>
                          <Download size={20} />
                          Download Media Now
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Dashboard Grid: Active Tasks & File Manager */}
      <div className="dashboard-grid">
        
        {/* Active Tasks Panel */}
        <section className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="panel-header">
            <h2 className="panel-title">
              <Activity size={18} style={{ color: 'var(--primary-light)' }} />
              Active Download Queues
            </h2>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {tasks.filter(t => t.status === 'downloading' || t.status === 'pending' || t.status === 'processing').length} running
            </span>
          </div>
          
          <div className="panel-content">
            {tasks.length === 0 ? (
              <div className="empty-state">
                <FileDown className="empty-icon" size={40} />
                <p>No active downloads in queue</p>
                <span style={{ fontSize: '0.8rem' }}>URLs you analyze and download will appear here.</span>
              </div>
            ) : (
              tasks.map(task => (
                <div key={task.id} className="task-card animate-fade-in">
                  <div className="task-info-header">
                    <span className="task-title" title={task.title}>{task.title}</span>
                    <span className={`task-badge ${task.status}`}>
                      {task.status}
                    </span>
                  </div>

                  {/* Progress info */}
                  {(task.status === 'downloading' || task.status === 'processing' || task.status === 'finished') && (
                    <div className="progress-container">
                      <div className="progress-bar-bg">
                        <div className="progress-bar-fill" style={{ width: `${task.percent}%` }} />
                      </div>
                      <div className="progress-meta">
                        <span>{task.percent}%</span>
                        {task.status === 'downloading' && (
                          <div style={{ display: 'flex', gap: '0.8rem' }}>
                            <span>{formatSpeed(task.speed)}</span>
                            <span>ETA: {formatETA(task.eta)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Filename output info */}
                  {task.filename && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-family-mono)' }}>
                      File: {task.filename}
                    </div>
                  )}

                  {/* Error detail */}
                  {task.status === 'error' && task.error && (
                    <div style={{ color: 'var(--error)', fontSize: '0.82rem', background: 'rgba(244,63,94,0.06)', padding: '0.5rem', borderRadius: '4px', border: '1px solid rgba(244,63,94,0.1)' }}>
                      Error: {task.error}
                    </div>
                  )}

                  {/* Actions Drawer & Console Log Toggle */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem', gap: '1rem' }}>
                    <button 
                      type="button" 
                      className="icon-btn" 
                      style={{ fontSize: '0.78rem', gap: '0.3rem', padding: '0.2rem 0.5rem', border: '1px solid var(--border-color)', borderRadius: '6px' }}
                      onClick={() => toggleLogs(task.id)}
                    >
                      <Terminal size={13} />
                      {expandedLogs[task.id] ? 'Hide Console' : 'Show Console'}
                    </button>

                    {(task.status === 'downloading' || task.status === 'pending') && (
                      <button 
                        type="button" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: '6px', gap: '0.25rem' }}
                        onClick={() => handleCancelTask(task.id)}
                      >
                        <Ban size={12} />
                        Cancel
                      </button>
                    )}

                    {(task.status === 'finished' || task.status === 'cancelled' || task.status === 'error') && (
                      <button 
                        type="button" 
                        className="btn btn-secondary animate-fade-in" 
                        style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem', borderRadius: '6px', gap: '0.25rem' }}
                        onClick={async () => {
                          // Call DELETE endpoint on server to clean up folder
                          if (task.status === 'finished' && task.filename) {
                            try {
                              await fetch(getApiUrl(`/api/downloads/${task.id}/${encodeURIComponent(task.filename)}`), { method: 'DELETE' });
                            } catch (e) {
                              console.error("Failed to delete task folder", e);
                            }
                          }
                          // Remove from React state list
                          setTasks(prev => prev.filter(t => t.id !== task.id));
                        }}
                      >
                        <Trash2 size={12} />
                        Dismiss
                      </button>
                    )}

                    {task.status === 'finished' && task.filename && (
                      <a 
                        href={getApiUrl(`/api/downloads/${task.id}/${encodeURIComponent(task.filename)}?auto_delete=true`)}
                        download={task.filename}
                        className="btn btn-primary animate-fade-in" 
                        style={{ 
                          padding: '0.3rem 0.7rem', 
                          fontSize: '0.78rem', 
                          borderRadius: '6px', 
                          gap: '0.25rem', 
                          background: 'var(--success)',
                          borderColor: 'var(--success)',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          alignItems: 'center',
                          color: '#fff'
                        }}
                        onClick={() => {
                          // We no longer manually delete the task card here.
                          // The browser needs the <a> tag to remain in the DOM to start the download.
                          // The server will stream the file, and once the download is complete,
                          // it will delete the file and broadcast a 'deleted' status to remove this card.
                        }}
                      >
                        <Download size={12} />
                        Save File
                      </a>
                    )}
                  </div>

                  {/* Terminal console drawer */}
                  {expandedLogs[task.id] && (
                    <div style={{
                      marginTop: '0.65rem',
                      background: '#040406',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '6px',
                      padding: '0.6rem 0.8rem',
                      fontFamily: 'var(--font-family-mono)',
                      fontSize: '0.72rem',
                      maxHeight: '130px',
                      overflowY: 'auto',
                      color: '#39ff14', // matrix neon green
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                      textAlign: 'left',
                      boxShadow: 'inset 0 0 10px rgba(0,0,0,0.8)'
                    }}>
                      {task.logs && task.logs.length > 0 ? (
                        task.logs.map((log: string, index: number) => (
                          <div key={index} style={{ wordBreak: 'break-all', opacity: 0.9 }}>
                            <span style={{ color: '#888', marginRight: '0.4rem', userSelect: 'none' }}>$</span>{log}
                          </div>
                        ))
                      ) : (
                        <div style={{ color: 'var(--text-muted)' }}>[system] Initializing terminal log stream...</div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Download History Panel */}
        <section className="glass-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="panel-header">
            <h2 className="panel-title">
              <History size={18} style={{ color: 'var(--primary-light)' }} />
              Download History (Browser Saved)
            </h2>
            {downloadHistory.length > 0 && (
              <button 
                type="button" 
                className="icon-btn icon-btn-danger" 
                style={{ fontSize: '0.8rem', gap: '0.25rem', padding: '0.3rem 0.6rem' }}
                onClick={() => {
                  if (confirm("Clear download history?")) setDownloadHistory([]);
                }}
              >
                Clear All
              </button>
            )}
          </div>

          <div className="panel-content">
            {downloadHistory.length === 0 ? (
              <div className="empty-state">
                <FileDown className="empty-icon" size={40} />
                <p>No download history yet</p>
                <span style={{ fontSize: '0.8rem' }}>Downloaded files will automatically stream to your browser and be listed here.</span>
              </div>
            ) : (
              downloadHistory.map(item => (
                <div key={item.id} className="file-card animate-fade-in" style={{ opacity: item.status === 'error' ? 0.85 : 1 }}>
                  <div className="file-icon-wrapper" style={{ 
                    background: item.status === 'error' ? 'rgba(244,63,94,0.1)' : 'rgba(16,185,129,0.1)', 
                    color: item.status === 'error' ? 'var(--error)' : 'var(--success)' 
                  }}>
                    {item.status === 'error' ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
                  </div>
                  
                  <div className="file-info" style={{ flex: 1, minWidth: 0 }}>
                    <div className="file-name" title={item.title} style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title}
                    </div>
                    <div className="file-meta">
                      {item.status === 'success' ? (
                        <span style={{ color: 'var(--success)', fontWeight: 500 }}>Saved to Device</span>
                      ) : (
                        <span style={{ color: 'var(--error)', fontWeight: 500 }}>Failed</span>
                      )}
                      <span>•</span>
                      <span>{new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {item.filename && (
                        <>
                          <span>•</span>
                          <span style={{ fontFamily: 'var(--font-family-mono)', fontSize: '0.72rem' }} title={item.filename}>
                            {item.filename.length > 22 ? item.filename.slice(0, 19) + '...' : item.filename}
                          </span>
                        </>
                      )}
                    </div>
                    {item.errorMessage && (
                      <div style={{ color: 'var(--error)', fontSize: '0.75rem', marginTop: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.errorMessage}>
                        {item.errorMessage}
                      </div>
                    )}
                  </div>

                  <div className="file-actions" style={{ flexShrink: 0 }}>
                    {/* Re-analyze URL button */}
                    <button 
                      type="button" 
                      className="icon-btn" 
                      title="Load URL to Download Again"
                      onClick={() => {
                        setUrl(item.url);
                        // Auto scroll to top where form is
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      <RotateCcw size={16} />
                    </button>
                    
                    {/* Clear individual item */}
                    <button 
                      type="button" 
                      className="icon-btn icon-btn-danger" 
                      title="Remove from History"
                      onClick={() => {
                        setDownloadHistory(h => h.filter(x => x.id !== item.id));
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Cookies Configuration Modal */}
      {showCookiesModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          animation: 'fadeIn 0.25s ease'
        }}>
          <div className="glass-card animate-fade-in" style={{
            width: '90%',
            maxWidth: '650px',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.9), 0 0 40px rgba(239, 68, 68, 0.1)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
              <h3 style={{ fontSize: '1.3rem', fontWeight: 700, background: 'linear-gradient(135deg, #ffffff, #ef4444)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                🔑 Paste cookies.txt File Content
              </h3>
              <button 
                type="button" 
                onClick={() => setShowCookiesModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '1rem',
                  outline: 'none',
                  transition: 'all 0.2s'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'; e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.4)'; e.currentTarget.style.color = '#fff'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Export cookies using a browser extension (like <strong style={{ color: '#fff' }}>Get cookies.txt LOCALLY</strong> or <strong style={{ color: '#fff' }}>cookies.txt</strong>) in Netscape format. Paste the entire content of the file below:
            </div>

            <form onSubmit={handleSaveCookies} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <textarea
                placeholder="# Netscape HTTP Cookie File&#10;# This is a generated file! Do not edit.&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE..."
                required
                rows={12}
                value={rawCookieText}
                onChange={(e) => setRawCookieText(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1rem',
                  color: '#fff',
                  fontFamily: 'var(--font-family-mono)',
                  fontSize: '0.82rem',
                  resize: 'vertical',
                  outline: 'none',
                  boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8)',
                  lineHeight: '1.5'
                }}
              />

              {cookiesError && (
                <div style={{ color: 'var(--error)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <AlertTriangle size={15} />
                  <span>{cookiesError}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.6rem 1.5rem', fontSize: '0.92rem' }}
                  onClick={() => {
                    setShowCookiesModal(false);
                    setCookiesError('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ padding: '0.6rem 2rem', fontSize: '0.92rem' }}
                  disabled={isSavingCookies}
                >
                  {isSavingCookies ? 'Saving and Syncing...' : 'Save & Configure Cookies'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
