// MADINENI LYRICS V1
(() => {
  'use strict';
  if (window.madineniLyricsConnected) return;
  window.madineniLyricsConnected = true;
  function start() {
    const media = typeof audio !== 'undefined' ? audio : document.querySelector('audio');
    if (!media || typeof media.addEventListener !== 'function') return;
    const base = (typeof API_BASE === 'string' ? API_BASE : typeof API === 'string' ? API : window.MUSIC_API_BASE || '').replace(/\/$/, '');
    const getSong = () => {
      if (typeof data !== 'undefined' && Array.isArray(data) && typeof current !== 'undefined') return data[current] || null;
      if (typeof state !== 'undefined' && Array.isArray(state.songs)) return state.songs[state.index] || null;
      return null;
    };
    const style = document.createElement('style');
    style.textContent = `
      .mm-lyrics-view{position:relative;color:inherit}
      .mm-lyrics-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 14px;color:#a5a1b8;font-size:13px}
      .mm-lyrics-meta a{color:#19d7ff;text-decoration:underline}
      .mm-lyrics-body{position:relative;max-height:460px;overflow:auto;overscroll-behavior:contain;padding:14px 10px;scrollbar-width:thin}
      .mm-lyrics-line{display:block;width:100%;border:0;background:transparent;text-align:left;padding:10px 8px;margin:0;font:inherit;font-size:20px;line-height:1.65;color:#85819c;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;transition:all .2s ease}
      button.mm-lyrics-line{cursor:pointer}
      button.mm-lyrics-line:hover{background:#8d40ff18;color:#f0ecff}
      .mm-lyrics-line.mm-active{color:#fff;font-weight:700;background:linear-gradient(90deg,#8d40ff2c,#19d7ff14);text-shadow:0 0 14px rgba(25,215,255,0.5);transform:scale(1.02)}
      .mm-lyrics-plain{white-space:pre-wrap;line-height:1.9;font-size:18px;overflow-wrap:anywhere;color:#e8e4f5}
      .mm-lyrics-retry,.mm-lyrics-open,.mm-lyrics-close{border:1px solid #8d40ff55;background:#8d40ff20;color:#fff;border-radius:18px;padding:9px 16px;font:inherit;cursor:pointer;transition:all .15s}
      .mm-lyrics-retry:hover,.mm-lyrics-open:hover,.mm-lyrics-close:hover{background:#8d40ff40;border-color:#a34dff}
      .mm-lyrics-retry:disabled{opacity:.5;cursor:default}
      .mm-lyrics-dialog{position:fixed;inset:auto;top:50%;left:50%;transform:translate(-50%,-50%);margin:0;width:min(92vw,680px);max-height:85vh;overflow:auto;padding:26px;background:#060817;color:#f7f4ff;border:1px solid #8d40ff55;border-radius:24px;box-shadow:0 0 60px rgba(141,64,255,0.35);backdrop-filter:blur(30px);z-index:2000}
      .mm-lyrics-dialog::backdrop{background:rgba(2,5,18,0.78);backdrop-filter:blur(10px)}
      .mm-lyrics-dialog h2{margin:0 0 16px;font-size:22px;background:linear-gradient(135deg,#9b4dff,#19d7ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .mm-lyrics-dialog .mm-lyrics-close{float:right}
      .mm-lyrics-open{margin:8px}
      @media(max-width:600px){.mm-lyrics-line{font-size:18px}.mm-lyrics-body{max-height:55vh}.mm-lyrics-dialog{width:96vw;padding:18px}}
    `;
    document.head.append(style);
    let host = null, dialog = null, button = document.getElementById('lyricsTab');
    let active = false, activeId = null, request = null, generation = 0, lines = [], nodes = [], previousTime = null, manualUntil = 0, retryTimer = null;
    const el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    // ---- Write authentication (manual lyrics save) ----
    // The write token is typed by an authorized user, kept only in this
    // closure (never stored, never placed in a URL) and sent in the
    // Authorization header. It is refused over plain HTTP except on localhost.
    let writeToken = '';
    const canSendToken = () => {
      try {
        const url = new URL(base || location.origin, location.href);
        return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      } catch { return false; }
    };
    function askForToken(message) {
      return new Promise(resolve => {
        const box = document.createElement('dialog');
        box.className = 'mm-lyrics-dialog';
        const form = el('form'); form.method = 'dialog';
        const label = el('p', message);
        const input = document.createElement('input');
        input.type = 'password'; input.autocomplete = 'off'; input.required = true;
        input.setAttribute('aria-label', 'Write token');
        input.style.cssText = 'width:100%;padding:10px;margin:12px 0;box-sizing:border-box';
        const save = el('button', 'Use token', 'mm-lyrics-retry'); save.value = 'ok';
        const cancel = el('button', 'Cancel', 'mm-lyrics-retry'); cancel.value = 'cancel'; cancel.formNoValidate = true;
        cancel.style.marginLeft = '10px';
        form.append(label, input, save, cancel); box.append(form);
        box.addEventListener('close', () => {
          const value = box.returnValue === 'ok' ? input.value.trim() : '';
          input.value = ''; box.remove(); resolve(value || null);
        });
        document.body.append(box); box.showModal(); input.focus();
      });
    }
    async function saveLyrics(songId, payload) {
      if (!canSendToken()) return {ok:false, message:'Saving lyrics requires HTTPS. Open the app over https:// to continue.'};
      let message = 'Enter the write token to save lyrics. It is kept in memory only.';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!writeToken) {
          const entered = await askForToken(message);
          if (!entered) return {ok:false, message:'Save cancelled: no token entered.'};
          writeToken = entered;
        }
        let response, body = {};
        try {
          response = await fetch(`${base}/api/songs/${encodeURIComponent(songId)}/lyrics`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${writeToken}`},
            body: JSON.stringify(payload)
          });
          body = await response.json().catch(() => ({}));
        } catch { return {ok:false, message:'Network error while saving lyrics.'}; }
        if (response.status === 401) { writeToken = ''; message = 'That token was not accepted. Enter the write token again.'; continue; }
        if (response.status === 503 && body.code === 'WRITE_AUTH_UNAVAILABLE') return {ok:false, message:'Saving is disabled: the server has no write token configured.'};
        if (response.status === 403 && body.code === 'HTTPS_REQUIRED') return {ok:false, message:'The server requires HTTPS for saving lyrics.'};
        if (response.ok && body.success) return {ok:true};
        return {ok:false, message: body.error || `Save failed (HTTP ${response.status}).`};
      }
      return {ok:false, message:'The write token was rejected too many times.'};
    }
    // Explicit refresh (?refresh=1) needs the write token; plain reads never do.
    async function refreshHeaders() {
      if (!canSendToken()) return {error: 'Refreshing lyrics requires HTTPS. Open the app over https:// to continue.'};
      if (!writeToken) {
        const entered = await askForToken('Enter the write token to search for lyrics again. It is kept in memory only.');
        if (!entered) return {error: 'Search cancelled: no token entered.'};
        writeToken = entered;
      }
      return {headers: {'Authorization': `Bearer ${writeToken}`}};
    }
    async function refreshProblem(response) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { writeToken = ''; return 'The write token was not accepted. Try again with the correct token.'; }
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After')) || 60;
        return `Too many attempts. Try again in about ${Math.ceil(seconds / 60)} minute(s).`;
      }
      if (response.status === 403 && body.code === 'HTTPS_REQUIRED') return 'The server requires HTTPS for this action.';
      if (response.status === 503 && body.code === 'WRITE_AUTH_UNAVAILABLE') return 'Searching again is disabled: the server has no write token configured.';
      return null;
    }
    const visible = () => active && !!host && !!host.querySelector('.mm-lyrics-view') && (!dialog || dialog.open);
    function stop() {
      active = false; generation++; request?.abort(); clearTimeout(retryTimer);
      request = null; nodes = []; lines = []; previousTime = null;
      button?.setAttribute('aria-pressed', 'false');
      button?.classList.remove('active-control');
    }
    function shell(song) {
      const view = el('section', undefined, 'mm-lyrics-view');
      view.setAttribute('aria-label', 'Song lyrics');
      const header = el('div', song?.title || 'Lyrics', 'mm-lyrics-meta');
      const body = el('div', undefined, 'mm-lyrics-body');
      body.setAttribute('tabindex', '0');
      body.setAttribute('aria-label', 'Lyrics. Select a timed line to seek.');
      body.addEventListener('wheel', () => {manualUntil = Date.now() + 8000;}, {passive:true});
      body.addEventListener('touchstart', () => {manualUntil = Date.now() + 8000;}, {passive:true});
      view.append(header, body); host.replaceChildren(view);
      return {view, header, body};
    }
    function showFailure(body, message, until = 0) {
      body.replaceChildren(el('p', message));
      const retry = el('button', 'Try again', 'mm-lyrics-retry');
      retry.type = 'button';
      retry.onclick = () => load();
      const delay = until - Date.now();
      if (delay > 0) {
        retry.disabled = true;
        const date = new Date(until);
        body.append(el('p', `You can retry after ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}.`));
        retryTimer = setTimeout(() => {if (retry.isConnected) retry.disabled = false;}, Math.min(delay,2147483647));
      }
      body.append(retry);
    }
    async function load(opts = {}) {
      const song = getSong();
      request?.abort(); clearTimeout(retryTimer);
      const token = ++generation;
      activeId = song?.id === undefined ? null : String(song.id);
      lines = []; nodes = []; previousTime = null; manualUntil = 0;
      const {header, body} = shell(song);
      if (!song || activeId === null) {body.append(el('p','Select a song to see its lyrics.'));return;}
      body.append(el('p','Finding lyrics…'));
      const controller = new AbortController();
      request = controller;
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        const url = `${base}/api/songs/${encodeURIComponent(activeId)}/lyrics${opts.refresh ? '?refresh=1' : ''}`;
        let requestHeaders;
        if (opts.refresh) {
          const auth = await refreshHeaders();
          if (auth.error) {body.replaceChildren(el('p', auth.error));return;}
          requestHeaders = auth.headers;
        }
        const response = await fetch(url, {signal:controller.signal,cache:'no-store',headers:requestHeaders});
        if (opts.refresh && [401,403,429,503].includes(response.status)) {
          const problem = await refreshProblem(response.clone());
          if (problem) {
            body.replaceChildren(el('p', problem));
            const back = el('button', 'Show saved result', 'mm-lyrics-retry');
            back.type = 'button'; back.onclick = () => load();
            body.append(back);
            return;
          }
        }
        if (!response.ok) {
          const seconds = Number(response.headers.get('Retry-After')) || 5;
          const error = new Error('Lyrics are temporarily unavailable.');
          error.until = Date.now() + seconds*1000;
          throw error;
        }
        const result = await response.json();
        if (token !== generation || !visible()) return;
        const lyric = result.data;
        if (!result.success || !lyric || String(lyric.song_id) !== activeId) throw new Error('Could not load lyrics for this song.');
        body.replaceChildren();
        if (lyric.status === 'instrumental') {body.append(el('p','This track is instrumental.'));return;}
        if (lyric.status === 'not_found') {
          body.append(el('p','Lyrics not found on public provider for this song.'));
          const actionsBox = el('div', undefined, 'mm-lyrics-meta');
          actionsBox.style.marginTop = '16px';
          const retryBtn = el('button', '↻ Search Again', 'mm-lyrics-retry');
          retryBtn.type = 'button';
          retryBtn.onclick = () => load({ refresh: true });
          actionsBox.append(retryBtn);

          const addBtn = el('button', '+ Add / Paste Lyrics', 'mm-lyrics-retry');
          addBtn.type = 'button';
          addBtn.style.marginLeft = '10px';
          const statusLine = el('p', '', 'mm-lyrics-meta');
          statusLine.setAttribute('role', 'alert');
          addBtn.onclick = async () => {
            const input = prompt('Paste plain lyrics or synchronized LRC timestamps for this song:');
            if (!input || !input.trim()) return;
            const isSynced = /\[\d{1,3}:\d{1,2}/.test(input);
            const payload = isSynced ? { syncedLyrics: input.trim() } : { plainLyrics: input.trim() };
            addBtn.disabled = true; statusLine.textContent = 'Saving lyrics…';
            const outcome = await saveLyrics(activeId, payload);
            addBtn.disabled = false;
            if (outcome.ok) load();
            else statusLine.textContent = outcome.message;
          };
          actionsBox.append(addBtn, statusLine);
          body.append(actionsBox);
          return;
        }
        if (lyric.status === 'error') {showFailure(body,'The lyrics service is temporarily unavailable.',Date.parse(lyric.retry_after)||0);return;}
        lines = Array.isArray(lyric.lines) ? lyric.lines.filter(x => Number.isFinite(x.time) && x.time>=0 && typeof x.text === 'string') : [];
        const mode = el('span', lines.length ? ' • Timed lyrics' : ' • Plain lyrics');
        header.append(mode);
        if (lyric.source) {
          const label = lyric.source==='lrclib'?'LRCLIB':lyric.source==='embedded'?'Embedded lyrics':'Local lyrics';
          let link;
          try { const url = new URL(lyric.source_url); if(url.protocol==='https:' && url.hostname==='lrclib.net') link='https://lrclib.net'; } catch {}
          if (link) {
            const source=el('a',label);source.href=link;source.target='_blank';source.rel='noopener noreferrer';header.append(source);
          } else header.append(el('span',label));
        }
        if (lines.length) {
          for (const line of lines) {
            const node=el('button',line.text||'♪','mm-lyrics-line');node.type='button';
            node.title='Seek to this line';
            node.onclick=()=>{media.currentTime=Number.isFinite(media.duration)?Math.min(line.time,media.duration):line.time;manualUntil=0;highlight();};
            nodes.push(node);body.append(node);
          }
          highlight();
        } else body.append(el('div',lyric.plainLyrics||'Lyrics not found for this song.','mm-lyrics-plain'));
      } catch(error) {
        if (token === generation && visible()) showFailure(body,error.name==='AbortError'?'The lyrics request timed out. Try again.':error.message,error.until||0);
      } finally {clearTimeout(timeout);}
    }
    function highlight() {
      if (!visible() || !nodes.length) return;
      const time = Number(media.currentTime) || 0;
      let low=0,high=lines.length-1,index=-1;
      while(low<=high){const mid=(low+high)>>1;if(lines[mid].time<=time){index=mid;low=mid+1;}else high=mid-1;}
      const stamp=index>=0?lines[index].time:null;
      if(stamp===previousTime)return;
      previousTime=stamp;
      for(let i=0;i<nodes.length;i++){
        const selected=stamp!==null && lines[i].time===stamp;
        nodes[i].classList.toggle('mm-active',selected);
        if(selected)nodes[i].setAttribute('aria-current','true');else nodes[i].removeAttribute('aria-current');
      }
      if(index>=0 && Date.now()>manualUntil){
        const box=host.querySelector('.mm-lyrics-body');
        const target=nodes[index].offsetTop-box.clientHeight/2+nodes[index].clientHeight/2;
        box.scrollTo({top:Math.max(0,target),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      }
    }
    function open() {
      if(dialog) {
        if(dialog.open) {
          dialog.close();
          stop();
          return;
        }
        dialog.showModal();
      }
      if(!dialog && typeof openFull==='function')openFull();
      active=true;
      button?.setAttribute('aria-pressed','true');
      button?.classList.add('active-control');
      load();
    }
    const panel=document.getElementById('detailPanel');
    if(button && panel){
      host=panel;button.onclick=open;
      document.addEventListener('click',event=>{
        const id=event.target.closest('button')?.id;
        if(['queueTab','miniQueue','collapse'].includes(id))stop();
      });
    }else{
      dialog=el('dialog',undefined,'mm-lyrics-dialog');
      const close=el('button','Close','mm-lyrics-close');close.type='button';close.onclick=()=>dialog.close();
      host=el('div');dialog.append(close,el('h2','Lyrics'),host);document.body.append(dialog);
      dialog.addEventListener('close',stop);dialog.addEventListener('cancel',stop);
      if(!button){button=el('button','Lyrics','mm-lyrics-open');button.type='button';
        const parent=document.querySelector('#player .top-actions, #player .section-head, #player .now-actions')||document.getElementById('player')||document.querySelector('.player')||document.body;
        parent.append(button);
      }
      button.onclick=open;
    }
    button.setAttribute('aria-pressed','false');
    const update=()=>{
      if(!visible())return;
      const song=getSong(),id=song?.id===undefined?null:String(song.id);
      if(id!==activeId)load();else highlight();
    };
    for(const event of ['timeupdate','seeking','seeked','loadedmetadata','loadstart','play'])media.addEventListener(event,update);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
