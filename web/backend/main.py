import os
import sys
import uuid
import shutil
import asyncio
import logging
import tempfile
from typing import Dict, List, Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# Add parent directory to path to import native yt_dlp module
PARENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.append(PARENT_DIR)

import yt_dlp

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("yt-dlp-web")

app = FastAPI(title="yt-dlp Web Control Panel API")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Use the OS temp directory — files are staged here temporarily,
# auto-pushed to the user's browser, then cleaned up. Nothing persists.
DOWNLOAD_DIR = os.path.join(tempfile.gettempdir(), "aeroytdl_tmp")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)
logger.info(f"Temp staging directory: {DOWNLOAD_DIR}")

# Global Tasks Store
# task_id -> task_details
tasks: Dict[str, dict] = {}
# Active WebSocket connections
active_connections: List[WebSocket] = []

class DownloadRequest(BaseModel):
    url: str
    format_id: Optional[str] = None
    audio_only: Optional[bool] = False
    audio_format: Optional[str] = "mp3"
    audio_quality: Optional[str] = "192"
    embed_thumbnail: Optional[bool] = False
    embed_metadata: Optional[bool] = False
    custom_name: Optional[str] = None
    # Advanced options
    speed_limit: Optional[str] = None
    write_subs: Optional[bool] = False
    cookies_from_browser: Optional[str] = None
    proxy: Optional[str] = None

class CookiesRequest(BaseModel):
    text: str

class CancelledError(Exception):
    pass

# Helper to check if ffmpeg is available
# Also probes common winget install paths so detection works without a shell restart
def get_ffmpeg_status() -> bool:
    if shutil.which("ffmpeg") is not None or shutil.which("ffmpeg.exe") is not None:
        return True

    # Probe well-known Windows install paths for ffmpeg (winget, Chocolatey, scoop, manual)
    extra_paths = []
    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        # winget installs ffmpeg here
        extra_paths.append(os.path.join(local_app, "Microsoft", "WinGet", "Links"))
        extra_paths.append(os.path.join(local_app, "Microsoft", "WinGet", "Packages"))

    program_files = [
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    ]
    for pf in program_files:
        if pf:
            extra_paths.append(os.path.join(pf, "ffmpeg", "bin"))

    # Also scan the updated PATH from Windows registry (works without shell restart)
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
        reg_path, _ = winreg.QueryValueEx(key, "PATH")
        winreg.CloseKey(key)
        extra_paths.extend(reg_path.split(os.pathsep))
    except Exception:
        pass

    for directory in extra_paths:
        candidate = os.path.join(directory, "ffmpeg.exe")
        if os.path.isfile(candidate):
            # Inject into process PATH so yt-dlp can find it too
            os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
            return True

    return False


# Broadcast updates to all connected WebSockets
async def broadcast_task_update(task_id: str, data: dict):
    # Update global task list
    if task_id in tasks:
        tasks[task_id].update(data)
        
    disconnected = []
    for connection in active_connections:
        try:
            await connection.send_json({
                "type": "task_update",
                "task_id": task_id,
                "task": tasks[task_id]
            })
        except Exception:
            disconnected.append(connection)
            
    for conn in disconnected:
        if conn in active_connections:
            active_connections.remove(conn)

# Progress hook for yt-dlp
class YtdlProgressHook:
    def __init__(self, task_id: str, loop: asyncio.AbstractEventLoop):
        self.task_id = task_id
        self.loop = loop

    def __call__(self, d: dict):
        # Check if cancellation was requested
        if tasks.get(self.task_id, {}).get("cancel_requested", False):
            raise CancelledError("Download cancelled by user")

        status = d.get("status")
        if status == "downloading":
            downloaded = d.get("downloaded_bytes", 0)
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            percent = (downloaded / total * 100) if total > 0 else 0
            
            # Format speed and ETA
            speed = d.get("speed") or 0 # bytes/sec
            eta = d.get("eta") or 0 # seconds
            filename = d.get("filename", "")
            
            update_data = {
                "status": "downloading",
                "downloaded_bytes": downloaded,
                "total_bytes": total,
                "percent": round(percent, 2),
                "speed": speed,
                "eta": eta,
                "filename": os.path.basename(filename)
            }
            asyncio.run_coroutine_threadsafe(
                broadcast_task_update(self.task_id, update_data), 
                self.loop
            )
        elif status == "finished":
            filename = d.get("filename", "")
            update_data = {
                "status": "processing",
                "percent": 100.0,
                "filename": os.path.basename(filename)
            }
            asyncio.run_coroutine_threadsafe(
                broadcast_task_update(self.task_id, update_data), 
                self.loop
            )

class YtdlLogger:
    def __init__(self, task_id: str, loop: asyncio.AbstractEventLoop):
        self.task_id = task_id
        self.loop = loop

    def debug(self, msg: str):
        msg = msg.strip()
        if not msg:
            return
        # Skip noisy download progress statements to prevent log bloating
        if msg.startswith('[download]') and '%' in msg:
            return
        self._log(msg)

    def info(self, msg: str):
        msg = msg.strip()
        if msg:
            self._log(msg)

    def warning(self, msg: str):
        msg = msg.strip()
        if msg:
            self._log(f"WARNING: {msg}")

    def error(self, msg: str):
        msg = msg.strip()
        if msg:
            self._log(f"ERROR: {msg}")

    def _log(self, msg: str):
        if self.task_id in tasks:
            if "logs" not in tasks[self.task_id]:
                tasks[self.task_id]["logs"] = []
            
            logs_list = tasks[self.task_id]["logs"]
            if not logs_list or logs_list[-1] != msg:
                logs_list.append(msg)
                if len(logs_list) > 100:
                    logs_list.pop(0)
                
                asyncio.run_coroutine_threadsafe(
                    broadcast_task_update(self.task_id, {"logs": logs_list}),
                    self.loop
                )

# Run yt-dlp download in thread
def run_download_thread(task_id: str, req: DownloadRequest, loop: asyncio.AbstractEventLoop):
    hook = YtdlProgressHook(task_id, loop)
    
    # Create isolated task subdirectory
    task_dir = os.path.join(DOWNLOAD_DIR, task_id)
    os.makedirs(task_dir, exist_ok=True)
    
    # Configure output template
    if req.custom_name:
        outtmpl = os.path.join(task_dir, f"{req.custom_name}.%(ext)s")
    else:
        outtmpl = os.path.join(task_dir, "%(title)s.%(ext)s")
        
    ydl_opts = {
        "outtmpl": outtmpl,
        "progress_hooks": [hook],
        "quiet": True,
        "no_warnings": True,
        "logger": YtdlLogger(task_id, loop),
        "overwrites": True,
    }

    # Set format settings
    if req.audio_only:
        ydl_opts["format"] = "bestaudio/best"
        postprocessors = []
        
        # If ffmpeg is available, extract audio, else download raw
        if get_ffmpeg_status():
            postprocessors.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": req.audio_format or "mp3",
                "preferredquality": req.audio_quality or "192",
            })
        ydl_opts["postprocessors"] = postprocessors
    elif req.format_id:
        # If format_id is selected, download it.
        # Note: If it's video-only and ffmpeg is available, yt-dlp will try to merge with best audio
        if "+" not in req.format_id and get_ffmpeg_status():
            # Automatically try to merge with best audio for DASH video streams
            ydl_opts["format"] = f"{req.format_id}+bestaudio/best"
        else:
            ydl_opts["format"] = req.format_id
    else:
        # Default to best quality
        ydl_opts["format"] = "bestvideo*+bestaudio/best"

    # Embed features (requires ffmpeg)
    if get_ffmpeg_status():
        if "postprocessors" not in ydl_opts:
            ydl_opts["postprocessors"] = []
            
        if req.embed_thumbnail:
            ydl_opts["writethumbnail"] = True
            ydl_opts["postprocessors"].append({
                "key": "EmbedThumbnail",
                "already_have_thumbnail": False
            })
        if req.embed_metadata:
            ydl_opts["postprocessors"].append({
                "key": "Metadata"
            })

    # Speed limits (ratelimit key in yt-dlp is bytes/sec)
    if req.speed_limit and req.speed_limit != "none":
        try:
            val = req.speed_limit.upper()
            if val.endswith("K"):
                ydl_opts["ratelimit"] = int(val[:-1]) * 1024
            elif val.endswith("M"):
                ydl_opts["ratelimit"] = int(val[:-1]) * 1024 * 1024
        except Exception as e:
            logger.warning(f"Could not set speed limit: {e}")

    # Embed subtitles
    if req.write_subs:
        ydl_opts["writesubtitles"] = True
        ydl_opts["allsubtitles"] = True
        if get_ffmpeg_status():
            if "postprocessors" not in ydl_opts:
                ydl_opts["postprocessors"] = []
            ydl_opts["postprocessors"].append({
                "key": "FFmpegEmbedSubtitle",
                "already_have_subtitle": False
            })

    # Browser cookies extraction
    if req.cookies_from_browser and req.cookies_from_browser != "none":
        if req.cookies_from_browser == "cookies.txt":
            cookies_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "cookies.txt"))
            if os.path.exists(cookies_file):
                ydl_opts["cookiefile"] = cookies_file
        else:
            ydl_opts["cookiesfrombrowser"] = (req.cookies_from_browser,)

    # Proxy settings
    if req.proxy and req.proxy.strip():
        ydl_opts["proxy"] = req.proxy.strip()

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Extract video title first
            info = ydl.extract_info(req.url, download=False)
            title = info.get("title", "Unknown Video")
            
            # Update title in task
            asyncio.run_coroutine_threadsafe(
                broadcast_task_update(task_id, {"title": title, "status": "downloading"}), 
                loop
            )
            
            # Start download and get final info dict
            info_dict = ydl.extract_info(req.url, download=True)
            
            # Extract final filename from info_dict
            filename_base = ""
            if info_dict and "requested_downloads" in info_dict and info_dict["requested_downloads"]:
                rd = info_dict["requested_downloads"][0]
                final_filename = rd.get("_filename") or rd.get("filepath") or rd.get("filename")
                if final_filename:
                    filename_base = os.path.basename(final_filename)
            
            # Subdirectory scanning fallback: find the actual media file in the task's isolated folder
            task_dir = os.path.join(DOWNLOAD_DIR, task_id)
            if os.path.exists(task_dir):
                files = [f for f in os.listdir(task_dir) if not f.endswith(('.part', '.ytdl', '.temp'))]
                if files:
                    media_files = [f for f in files if not f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.vtt', '.srt'))]
                    resolved_filename = media_files[0] if media_files else files[0]
                    filename_base = resolved_filename

            if not filename_base:
                # Fallback to checking the last updated filename in task
                filename_base = tasks.get(task_id, {}).get("filename", "")

            # Mark finished and broadcast final filename
            asyncio.run_coroutine_threadsafe(
                broadcast_task_update(task_id, {
                    "status": "finished", 
                    "percent": 100.0,
                    "filename": filename_base
                }), 
                loop
            )
            logger.info(f"Task {task_id} completed successfully")
    except CancelledError:
        logger.info(f"Task {task_id} was cancelled")
        asyncio.run_coroutine_threadsafe(
            broadcast_task_update(task_id, {"status": "cancelled", "percent": 0.0}), 
            loop
        )
    except Exception as e:
        logger.error(f"Task {task_id} failed: {str(e)}")
        asyncio.run_coroutine_threadsafe(
            broadcast_task_update(task_id, {"status": "error", "error": str(e)}), 
            loop
        )

# API Endpoints

@app.get("/api/status")
def get_system_status():
    cookies_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "cookies.txt"))
    cookies_configured = os.path.exists(cookies_file) and os.path.getsize(cookies_file) > 0
    return {
        "ffmpeg_installed": get_ffmpeg_status(),
        "downloads_directory": DOWNLOAD_DIR,
        "platform": sys.platform,
        "cookies_configured": cookies_configured
    }

@app.post("/api/cookies")
def save_cookies(req: CookiesRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Cookie content cannot be empty")
    
    # Check for basic Netscape file formats
    clean_text = req.text.strip()
    if not (clean_text.startswith("# HTTP Cookie File") or clean_text.startswith("# Netscape HTTP Cookie File")):
        raise HTTPException(status_code=400, detail="Invalid format. Cookie file must start with '# HTTP Cookie File' or '# Netscape HTTP Cookie File'")
        
    cookies_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "cookies.txt"))
    try:
        content = req.text.replace("\r\n", "\n").replace("\n", os.linesep)
        with open(cookies_file, "w", encoding="utf-8") as f:
            f.write(content)
        return {"status": "success", "message": "Cookies saved successfully to cookies.txt"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/info")
def get_video_info(url: str, cookies_from_browser: Optional[str] = None, proxy: Optional[str] = None):
    if not url:
        raise HTTPException(status_code=400, detail="URL query parameter is required")
        
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
    }

    if cookies_from_browser and cookies_from_browser != "none":
        if cookies_from_browser == "cookies.txt":
            cookies_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "cookies.txt"))
            if os.path.exists(cookies_file):
                ydl_opts["cookiefile"] = cookies_file
        else:
            ydl_opts["cookiesfrombrowser"] = (cookies_from_browser,)

    if proxy and proxy.strip():
        ydl_opts["proxy"] = proxy.strip()
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            # Clean up and structure formats list
            formats = []
            for f in info.get("formats", []):
                vcodec = f.get("vcodec", "none")
                acodec = f.get("acodec", "none")
                
                # Determine type
                if vcodec != "none" and acodec == "none":
                    type_str = "video_only"
                elif acodec != "none" and vcodec == "none":
                    type_str = "audio_only"
                else:
                    type_str = "video_and_audio"
                    
                formats.append({
                    "format_id": f.get("format_id"),
                    "ext": f.get("ext"),
                    "resolution": f.get("resolution") or f"{f.get('width')}x{f.get('height')}" if f.get('width') else "audio",
                    "filesize": f.get("filesize") or f.get("filesize_approx") or 0,
                    "fps": f.get("fps"),
                    "vcodec": vcodec,
                    "acodec": acodec,
                    "type": type_str,
                    "format_note": f.get("format_note")
                })
                
            return {
                "id": info.get("id"),
                "title": info.get("title"),
                "thumbnail": info.get("thumbnail"),
                "description": info.get("description", "")[:1000], # Trucated for size
                "duration": info.get("duration"),
                "uploader": info.get("uploader") or info.get("channel"),
                "view_count": info.get("view_count"),
                "upload_date": info.get("upload_date"),
                "webpage_url": info.get("webpage_url"),
                "formats": formats
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/download")
async def start_download(req: DownloadRequest, background_tasks: BackgroundTasks):
    task_id = str(uuid.uuid4())
    
    tasks[task_id] = {
        "id": task_id,
        "url": req.url,
        "title": "Fetching details...",
        "status": "pending",
        "percent": 0.0,
        "speed": 0.0,
        "eta": 0,
        "filename": "",
        "error": None,
        "cancel_requested": False,
        "logs": []
    }
    
    loop = asyncio.get_running_loop()
    background_tasks.add_task(run_download_thread, task_id, req, loop)
    
    return {"task_id": task_id, "status": "pending"}

@app.get("/api/tasks")
def list_tasks():
    return list(tasks.values())

@app.post("/api/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
        
    tasks[task_id]["cancel_requested"] = True
    tasks[task_id]["status"] = "cancelling"
    return {"status": "cancel_requested"}

@app.get("/api/downloads")
def list_downloads():
    files = []
    if not os.path.exists(DOWNLOAD_DIR):
        return []
        
    for filename in os.listdir(DOWNLOAD_DIR):
        # Ignore temp files or part files
        if filename.endswith(".part") or filename.endswith(".ytdl"):
            continue
            
        filepath = os.path.join(DOWNLOAD_DIR, filename)
        if os.path.isfile(filepath):
            stat = os.stat(filepath)
            
            # Simple mime-type guessing
            ext = os.path.splitext(filename)[1].lower()
            is_video = ext in [".mp4", ".mkv", ".webm", ".avi", ".mov"]
            is_audio = ext in [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus"]
            
            files.append({
                "filename": filename,
                "size": stat.st_size,
                "created_at": stat.st_ctime,
                "is_video": is_video,
                "is_audio": is_audio,
            })
            
    # Sort files by newest created first
    files.sort(key=lambda x: x["created_at"], reverse=True)
    return files

@app.get("/api/downloads/{task_id}/{filename}")
def get_download_file(task_id: str, filename: str, background_tasks: BackgroundTasks, auto_delete: bool = False):
    task_dir = os.path.join(DOWNLOAD_DIR, task_id)
    filepath = os.path.join(task_dir, filename)
    
    # If the requested filename doesn't exist, search the task directory for any completed media file
    if not os.path.exists(filepath) or not os.path.isfile(filepath):
        if os.path.exists(task_dir) and os.path.isdir(task_dir):
            files = [f for f in os.listdir(task_dir) if not f.endswith(('.part', '.ytdl', '.temp'))]
            if files:
                # Prefer non-image, non-subtitle files
                media_files = [f for f in files if not f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp', '.vtt', '.srt'))]
                filename = media_files[0] if media_files else files[0]
                filepath = os.path.join(task_dir, filename)
                
    if not os.path.exists(filepath) or not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="File not found")

    async def _delete_after_serve():
        # Wait a short moment to ensure Windows completely closes the file handle
        await asyncio.sleep(2.0)
        try:
            if os.path.exists(task_dir):
                shutil.rmtree(task_dir, ignore_errors=True)
                logger.info(f"Cleaned up temp task directory: {task_id}")
                
            # Delete task from global tasks dictionary to clear it from the active lists
            if task_id in tasks:
                tasks.pop(task_id, None)
                
            # Broadcast the deletion to all clients so the frontend UI clears the card
            disconnected = []
            for connection in active_connections:
                try:
                    await connection.send_json({
                        "type": "task_update",
                        "task_id": task_id,
                        "task": {"id": task_id, "status": "deleted"}
                    })
                except Exception:
                    disconnected.append(connection)
            for conn in disconnected:
                if conn in active_connections:
                    active_connections.remove(conn)

        except Exception as e:
            logger.warning(f"Could not clean temp task directory {task_id}: {e}")

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}

    if auto_delete:
        response = FileResponse(filepath, headers=headers)
        background_tasks.add_task(_delete_after_serve)
        return response
    else:
        return FileResponse(filepath, headers=headers)

@app.delete("/api/downloads/{task_id}/{filename}")
def delete_download_file(task_id: str, filename: str):
    task_dir = os.path.join(DOWNLOAD_DIR, task_id)
    
    # Delete task from global tasks dictionary
    if task_id in tasks:
        tasks.pop(task_id, None)
        
    if not os.path.exists(task_dir) or not os.path.isdir(task_dir):
        raise HTTPException(status_code=404, detail="Task directory not found")
        
    try:
        shutil.rmtree(task_dir, ignore_errors=True)
        return {"status": "deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# WebSocket endpoint for real-time task updates
@app.websocket("/api/ws/tasks")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    
    # Send current tasks list immediately upon connection
    await websocket.send_json({
        "type": "tasks_list",
        "tasks": list(tasks.values())
    })
    
    try:
        while True:
            # We just wait for incoming client pings or messages, though we primarily broadcast updates
            data = await websocket.receive_text()
            # Handle messages from client if needed
    except WebSocketDisconnect:
        active_connections.remove(websocket)
        logger.info("WebSocket disconnected")
    except Exception as e:
        if websocket in active_connections:
            active_connections.remove(websocket)
        logger.error(f"WebSocket error: {str(e)}")

# Mount static files for Hono frontend build in production
FRONTEND_DIST_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist"))
if os.path.exists(FRONTEND_DIST_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
else:
    @app.get("/")
    def read_root():
        return {"message": "FastAPI is running. Frontend static files have not been built yet."}
