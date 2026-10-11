(function installSIWCSubtitleBridge(root) {
  'use strict';
  const api = root?.lilac, manual = root?.LilacManualSubtitle;
  if (!api?.patchSIWCStatus || !api?.patchSIWCTranslate || !manual) return;
  const $ = selector => document.querySelector(selector);
  let currentRun = null, serial = 0, preparing = false;
  const text = (node, value) => { if (node) node.textContent = String(value || ''); };

  function active(run) {
    return run && run === currentRun && !run.cancelled &&
      run.playbackId === playbackRequestId &&
      run.subtitle === currentSubtitle &&
      run.episodeKey === subtitleStoreKey();
  }
  function render() {
    const row = $('#patch02SIWCRow'), panel = $('#patch02SIWCPanel'), progress = $('#patch02SIWCProgress');
    if (!row || !panel) return;
    row.classList.toggle('hidden', !currentSubtitle?.path || !currentSubtitle?.src);
    panel.classList.toggle('hidden', !currentRun && !panel.dataset.notice);
    if (!currentRun) return;
    const amount = manual.progress(currentRun.parsed.cues, currentRun.translations);
    text(progress, amount.completed + '/' + amount.total + '문장 (' + amount.percent + '%) · 묶음 ' +
      Math.min(currentRun.index+1,currentRun.batches.length) + '/' + currentRun.batches.length);
    text($('#patch02SIWCStatus'), currentRun.message);
    $('#patch02SIWCStart').disabled = preparing || currentRun.busy;
    $('#patch02SIWCCancel').disabled = !currentRun.busy;
  }
  function notice(message) {
    const panel = $('#patch02SIWCPanel');
    if (panel) panel.dataset.notice = 'true';
    text($('#patch02SIWCStatus'), message);
    render();
  }
  function sessionPayload(run,status) {
    return {
      sourcePath: run.sourcePath, sourceLabel: run.sourceLabel,
      title: run.title, episode: run.episode, language: run.language,
      index: run.index, batchCount: run.batches.length,
      totalCueCount: run.batches.reduce((sum,batch)=>sum+batch.length,0),
      translations: run.translations, answer: '', status,
      message: run.message, cleanupAt: null
    };
  }
  async function persist(run,status) {
    if (!run?.fingerprint) return;
    await api.patchSaveManualTranslationSession(run.episodeKey,run.fingerprint,sessionPayload(run,status));
  }

  async function translate() {
    if (preparing || currentRun?.busy) return;
    preparing = true;
    const source=currentSubtitle, playbackId=playbackRequestId;
    if (!source?.path || !source?.src) {
      notice('영어 또는 일본어 원본 자막을 먼저 선택해 주세요.'); return;
    }
    let run;
    try {
      const account=await api.patchSIWCStatus();
      if (!account.available || !account.authorized) {
        notice('설정 > 자막 자동 번역에서 ChatGPT 계정을 연결하고 AI 사용 권한을 승인해 주세요.'); return;
      }
      const models=await api.patchSIWCModels();
      const selected=$('#patch0102SIWCModel')?.value;
      const model=models.find(row=>row.id===selected) || models[0];
      if (!model) { notice('ChatGPT 계정에서 번역에 사용할 수 있는 모델이 없습니다.'); return; }
      if (source!==currentSubtitle || playbackId!==playbackRequestId) return;
      const fetched=await fetch(source.src);
      if (!fetched.ok) throw new Error('원본 자막 파일을 읽지 못했습니다.');
      const original=await fetched.text(),parsed=manual.parseWebVtt(original);
      const rawDialogue=parsed.cues.map(cue=>cue.text).join('\n');
      if (/[가-힣]/.test(rawDialogue) && !/[ぁ-ヿA-Za-z]/.test(rawDialogue)) throw new Error('이미 한국어인 자막은 번역하지 않습니다.');
      const fingerprint=await manual.fingerprintWebVtt(original);
      const language=manual.detectSourceLanguage(parsed.cues),batches=manual.makeBatches(parsed.cues);
      const episodeKey=subtitleStoreKey();
      if(!episodeKey || !batches.length)throw new Error('해당 회차의 번역할 자막이 없습니다.');
      if(source!==currentSubtitle || playbackId!==playbackRequestId)return;
      const already=await api.patchHasManualTranslationForSource(episodeKey,source.path);
      if (already && !confirm('이 자막은 이미 번역되어 있습니다. 새로운 ChatGPT 계정 번역을 시작할까요? 기존 번역본은 유지됩니다.')) return;
      const previous=await api.patchManualTranslationSession(episodeKey,fingerprint);
      if(source!==currentSubtitle || playbackId!==playbackRequestId)return;
      const translations=Object.create(null);
      let index=0;
      if(previous && previous.sourcePath===source.path && previous.language===language &&
        previous.batchCount===batches.length && previous.totalCueCount===batches.reduce((sum,b)=>sum+b.length,0) &&
        previous.status!=='completed'){
        const ids=new Set(parsed.cues.map(cue=>String(cue.id)));
        for(const [id,value] of Object.entries(previous.translations||{})){
          if(!ids.has(id)||typeof value!=='string')throw new Error('이전 번역 세션의 자막 ID가 맞지 않아 이어하기를 중단했습니다.');
          translations[id]=value;
        }
        index=Number(previous.index)||0;
        if(!Number.isInteger(index)||index<0||index>batches.length)throw new Error('이전 작업의 위치가 올바르지 않습니다.');
        for(const batch of batches.slice(0,index))for(const cue of batch)
          if(!Object.hasOwn(translations,cue.id))throw new Error('이전 완료 묶음에 누락된 자막이 있습니다.');
      }
      run={
        subtitle:source,sourcePath:source.path,sourceLabel:source.label||'원본 자막',
        episodeKey,playbackId,fingerprint,parsed,batches,language,
        title:currentPlaybackContext.subtitleTitle||$('#playerTitle')?.textContent||'',
        episode:Number($('#skipEpisode')?.value)||Number(currentPlaybackContext.episode?.number)||1,
        model:model.id,index,translations,busy:true,cancelled:false,
        message:'ChatGPT 계정 번역 준비 중…',id:++serial
      };
      currentRun=run;delete $('#patch02SIWCPanel').dataset.notice;render();
      for(;active(run)&&run.index<run.batches.length;){
        const batch=run.batches[run.index];
        const instructions=await api.patchTranslationPrompt(run.language);
        if(!active(run))return;
        const first=run.parsed.cues.findIndex(cue=>cue.id===batch[0].id);
        const last=run.parsed.cues.findIndex(cue=>cue.id===batch[batch.length-1].id);
        const prompt=manual.makePrompt({
          title:run.title,episode:run.episode,sourceLanguage:run.language,translationInstructions:instructions,
          items:batch,
          contextBefore:run.parsed.cues.slice(Math.max(0,first-2),first).map(c=>({id:c.id,text:c.text})),
          contextAfter:run.parsed.cues.slice(last+1,last+3).map(c=>({id:c.id,text:c.text}))
        });
        run.message='ChatGPT가 ' + (run.index+1) + '/' + run.batches.length + '묶음을 번역하는 중…';
        render();
        const answer=await api.patchSIWCTranslate({model:run.model,prompt});
        if(!active(run))return;
        Object.assign(run.translations,manual.parseResponse(answer,batch.map(c=>c.id)));
        run.index++;
        run.message='번역 결과 ID 검증 완료 · 다음 묶음을 준비합니다.';
        await persist(run,run.index===run.batches.length?'saving':'ready');
        if(!active(run))return;
        render();
      }
      if(!active(run))return;
      run.message='한국어 자막 저장 및 적용 중…';render();
      const vtt=manual.renderWebVtt(run.parsed,run.translations);
      const saved=await api.patchSaveManualSubtitle({
        key:run.episodeKey,text:vtt,from:run.sourcePath,fromName:run.sourceLabel
      });
      if(!active(run))return;
      run.message='ChatGPT 계정 번역이 완료됐습니다.';
      await persist(run,'completed');
      currentRun=null;
      currentSubtitlePath=saved.path;
      attachSubtitle(saved.url,'ChatGPT 계정 번역',{
        path:saved.path,source:'chatgpt',from:run.sourcePath,fromName:run.sourceLabel,saved:true
      });
      const state=$('#subtitleState');if(state)state.textContent='ChatGPT 계정으로 번역한 한국어 자막을 적용했습니다.';
      notice('번역 완료 · 한국어 자막을 영상에 적용했습니다. 원본 자막은 그대로 남아 있습니다.');
    }catch(error) {
      if(run && active(run)){
        run.message='번역을 완료하지 못했습니다: '+error.message+' 완료된 문장은 보존했습니다.';
        try{await persist(run,'error')}catch{}
      }
      notice(run?.message||('ChatGPT 계정 번역 실패: '+error.message));
    }finally {
      preparing = false;
      if(run){run.busy=false;if(active(run))render();}
    }
  }

  async function cancel() {
    const run=currentRun;
    if(!run||!run.busy)return;
    run.cancelled=true;
    currentRun=null;
    try{await api.patchSIWCCancel();}catch{}
    try{await persist(run,'cancelled')}catch{}
    notice('번역 중단 · 완료된 묶음은 해당 회차에 보존했습니다. 다시 누르면 이어서 번역합니다.');
  }
  function install() {
    const target=$('#subtitleTranslateRow');
    if(!target||$('#patch02SIWCRow'))return;
    const row=document.createElement('div');row.id='patch02SIWCRow';row.className='sheet-button-row hidden';
    row.innerHTML='<button id="patch02SIWCStart" type="button" class="sheet-button">ChatGPT 계정으로 한국어 자동 번역</button>';
    const panel=document.createElement('div');panel.id='patch02SIWCPanel';panel.className='patch0102-manual-panel hidden';
    panel.innerHTML='<b>ChatGPT 계정 번역</b><p id="patch02SIWCProgress" role="status"></p><p id="patch02SIWCStatus" role="status">기존 자막을 보존하고 한국어 번역본을 따로 저장합니다.</p><div class="patch0102-manual-actions"><button id="patch02SIWCCancel" type="button" disabled>중단 · 작업 보존</button></div>';
    target.after(row,panel);
    $('#patch02SIWCStart').addEventListener('click',()=>{void translate()});
    $('#patch02SIWCCancel').addEventListener('click',()=>{void cancel()});
    root.addEventListener('lilac-subtitle-changed',render);
    // v0.5.14 upstream does not emit subtitle-changed; also track selections
    // without modifying any upstream player function or existing patch behavior.
    root.setInterval(render,1000);
    render();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})(window);
