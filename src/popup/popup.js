// ════════════════════════════════════════════════════════════
// 即投 — Popup 入口（路由 + 消息监听）
// ════════════════════════════════════════════════════════════
// Depends on: constants.js, tag-data.js, helpers.js, state.js
// Depends on: render-a.js, render-b.js, render-review.js
// Depends on: events-a.js, events-b.js

// ── 数组 → Data URL 转换（兼容 options 页上传的 data 格式） ──
window.arrayBufferToDataUrl=function(arr,mimeType){
  try{
    if(!arr||!arr.length)return null;
    var bytes=new Uint8Array(arr);
    // Chunked conversion avoids O(n^2) string concatenation
    var chunkSize=8192,chunks=[];
    for(var i=0;i<bytes.length;i+=chunkSize){
      chunks.push(String.fromCharCode.apply(null,bytes.subarray(i,i+chunkSize)));
    }
    return 'data:'+mimeType+';base64,'+btoa(chunks.join(''));
  }catch(e){return null}
};

// ── DOM References ──
var E={};
var _debounceJobsTimer=null;
let p1dPollHandle = null;
function initDomRefs(){
  E.headerLeft=$('#headerLeft');E.hdrTitle=$('#hdrTitle');E.btnBack=$('#btnBack');
  E.settingsPanel=$('#settingsPanel');E.resultsPanel=$('#resultsPanel');
  E.cityInput=$('#cityInput');E.cityChipContainer=$('#cityChipContainer');E.citySelectedArea=$('#citySelectedArea');
  E.posSearch=$('#posSearch');E.posSearchClear=$('#posSearchClear');E.posBrowseArea=$('#posBrowseArea');
  E.indSearch=$('#indSearch');E.indSearchClear=$('#indSearchClear');E.indArea=$('#indArea');
  E.expandIndustries=$('#expandIndustries');
  E.workAreaChips=$('#workAreaChips');E.jobTypeChips=$('#jobTypeChips');
  E.salaryChips=$('#salaryChips');E.expChips=$('#expChips');E.eduChips=$('#eduChips');
  E.sizeChips=$('#sizeChips');E.stageChips=$('#stageChips');
  E.bottomSettings=$('#bottomSettings');E.bottomResults=$('#bottomResults');
  E.btnReset=$('#btnReset');E.btnCollect=$('#btnCollect');E.btnSend=$('#btnSend');
  E.btnViewLastReview=$('#btnViewLastReview');
  E.resultCountNum=$('#resultCountNum');E.resultCountTotal=$('#resultCountTotal');
  E.hiddenFileInput=$('#hiddenFileInput');E.hiddenFileInputB=$('#hiddenFileInputB');E.resumeThumbArea=$('#resumeThumbArea');
  E.progressSection=$('#progressSection');E.progressFill=$('#progressFill');
  E.progressText=$('#progressText');E.progressSub=$('#progressSub');
  E.resultsContent=$('#resultsContent');E.groupedContent=$('#groupedContent');
  E.gearBtn=$('#gearBtn');E.settingsOverlay=$('#settingsOverlay');
  E.settingsClose=$('#settingsClose');
}

// ════════════════════════════════════════════════════════════
// ROUTE FUNCTIONS
// ════════════════════════════════════════════════════════════

function toSettings(){
  Store.set('mode','settings');Store.set('progressDone',false);
  Store.set('collecting',false);Store.set('sending',false);
  Store.set('reviewDismissed',true);
  // 回 A 页＝放弃上一轮采集结果：清 Store + 渲染 DOM，否则重新筛选进 B 页会残留上次岗位/计数
  Store.set('jobs',[]);Store.set('groups',[]);Store.set('groupExpanded',{});
  if(E.groupedContent)E.groupedContent.innerHTML='';
  E.hdrTitle.classList.remove('hidden');E.btnBack.classList.add('hidden');
  E.settingsPanel.classList.remove('hidden');E.resultsPanel.classList.add('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.remove('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';E.progressText.textContent='正在搜索匹配岗位...';
  E.progressSub.textContent='';
  // 清掉 review 面板内容（不只是隐藏）——否则上一批 review DOM 残留，A 页下滑可见、且会被重渲染盖上来
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}
  updateLastReviewEntry();
  window.renderSettings();
}

/** 记录用户主动修改配置，防止旧 review 状态再次自动覆盖筛选页。 */
window.dismissReviewForConfigEdit=function(){
  Store.set('reviewDismissed',true);
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}
  if(E.resultsContent)E.resultsContent.classList.add('hidden');
  if(E.progressSection)E.progressSection.classList.remove('hidden');
  updateLastReviewEntry();
};

/** 按当前缓存状态控制“查看上次投递结果”入口显示。 */
function updateLastReviewEntry(){
  if(!E.btnViewLastReview)return;
  var last=Store.get('lastReview');
  var hasLast=last&&Array.isArray(last.sendResults)&&last.sendResults.length;
  E.btnViewLastReview.classList.toggle('hidden',!hasLast);
}

/** 从内存、SW 或 storage 恢复上一轮 review，并由用户显式打开。 */
function openLastReview(){
  function show(last){
    if(!last||!Array.isArray(last.sendResults)||!last.sendResults.length)return;
    Store.set('lastReview',last);
    Store.set('reviewDismissed',false);
    Store.set('mode','results');
    E.hdrTitle.classList.add('hidden');
    E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');
    E.resultsPanel.classList.remove('hidden');
    E.progressSection.classList.add('hidden');
    E.bottomSettings.classList.add('hidden');
    window.renderReview(last.sendResults,last.duration||0,last.missedCount||0);
  }
  var cached=Store.get('lastReview');
  if(cached&&cached.sendResults&&cached.sendResults.length){show(cached);return}
  try{
    chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
      if(resp&&resp.success&&resp.state&&resp.state.sendResults&&resp.state.sendResults.length){
        show({sendResults:resp.state.sendResults,duration:resp.state.sendDuration||0,missedCount:(resp.state._v6MissedJobs||[]).length});
      }else{
        chrome.storage.local.get([STORAGE_KEYS.SW.SEND_RESULTS,STORAGE_KEYS.SW.SEND_DURATION,STORAGE_KEYS.SW.MISSED_JOBS],function(items){
          show({sendResults:items[STORAGE_KEYS.SW.SEND_RESULTS]||[],duration:items[STORAGE_KEYS.SW.SEND_DURATION]||0,missedCount:(items[STORAGE_KEYS.SW.MISSED_JOBS]||[]).length});
        });
      }
    });
  }catch(e){}
}

/** popup 重开时预热上一轮 review 入口，但不自动打开。 */
function hydrateLastReviewEntry(){
  try{
    chrome.storage.local.get([STORAGE_KEYS.SW.SEND_RESULTS,STORAGE_KEYS.SW.SEND_DURATION,STORAGE_KEYS.SW.MISSED_JOBS],function(items){
      var results=items[STORAGE_KEYS.SW.SEND_RESULTS]||[];
      if(!Array.isArray(results)||!results.length)return;
      Store.set('lastReview',{sendResults:results,duration:items[STORAGE_KEYS.SW.SEND_DURATION]||0,missedCount:(items[STORAGE_KEYS.SW.MISSED_JOBS]||[]).length});
      updateLastReviewEntry();
    });
  }catch(e){}
}

function toResults(){
  Store.set('mode','results');Store.set('progressDone',false);Store.set('collecting',true);
  // 清上一轮结果，确保新一轮收集走 _processJobsUpdate 的「首次构建」分支重渲染
  Store.set('groups',[]);Store.set('jobs',[]);Store.set('groupExpanded',{});
  // B 页无缓存：清空后到本次采集数据到来前，不画任何旧广播，保持加载态（骨架屏）。
  Store.set('awaitingCollect',true);Store.set('groupExpanded',{});
  // B 页无缓存：标记「等待新一轮采集」，在 SW 确认新采集开始(phase='collecting')前，
  // handleStateUpdate 忽略上一轮残留 state，杜绝旧结果回填造成混淆。
  Store.set('awaitingCollect',true);
  // 重置投递按钮到初始态——杜绝上一批「已发送完成」(disabled+绿底)+sending=true 残留带进本批，
  // 否则进 B 页按钮显示「已发送完成」、首点命中停止分支(if sending)只重置文案、需点两次才开投。
  Store.set('sending',false);
  if(E.btnSend){E.btnSend.textContent='一键发送';E.btnSend.classList.remove('sending');E.btnSend.disabled=false;E.btnSend.style.background='';}
  E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
  E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';E.progressText.textContent='正在搜索匹配岗位...';
  E.progressSub.textContent='根据筛选条件智能匹配中';
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;} // 彻底清上一批 review，杜绝混杂
  // Skeleton: show placeholder cards matching selected position count
  var posCount=((Store.get('selectedPositions')||[]).concat(Store.get('customPositions')||[])).length||1;
  window.showSkeleton(posCount);
  try{
    var params=window.buildCollectParams();
    chrome.runtime.sendMessage({type:MSG.START_COLLECT,params:params},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        Store.set('collecting',false);
        Store.set('awaitingCollect',false); // 启动失败：解除挡板，露出错误文案而非卡在骨架屏
        E.progressText.textContent='收集启动失败';
        E.progressSub.textContent=resp?.error||'请确保在BOSS直聘页面打开后重试';
      }
    });
  }catch(e){
    Store.set('collecting',false);
    E.progressText.textContent='收集启动失败';
    E.progressSub.textContent='请刷新页面后重试';
  }
  startBPagePollFallback();
}

/** 将 SW/storage 里的岗位快照恢复为 B 页可渲染状态，优先保留本地勾选状态。 */
function restoreJobListSnapshot(snapshot){
  if(!snapshot||!Array.isArray(snapshot.jobs)||!snapshot.jobs.length)return false;

  var localJobs=Store.get('jobs')||[];
  var checkedById={};
  localJobs.forEach(function(job){
    if(job&&job.id!==undefined&&job.checked!==undefined)checkedById[job.id]=job.checked;
  });

  var jobs=JSON.parse(JSON.stringify(snapshot.jobs));
  jobs.forEach(function(job){
    if(job&&Object.prototype.hasOwnProperty.call(checkedById,job.id)){
      job.checked=checkedById[job.id];
    }else if(job&&job.checked===undefined){
      job.checked=true;
    }
  });
  Store.set('jobs',jobs);

  if(Array.isArray(snapshot.selectedPositions))Store.set('selectedPositions',snapshot.selectedPositions);
  if(Array.isArray(snapshot.customPositions))Store.set('customPositions',snapshot.customPositions);
  if(snapshot.greetings)Store.set('greetings',snapshot.greetings);

  var groups=Store.get('groups')||[];
  if(groups.length){
    window.syncGroupsWithJobs&&window.syncGroupsWithJobs();
  }else{
    var picker=Store.get('selectedPositions')||[];
    var custom=Store.get('customPositions')||[];
    var nextGroups=window.prepareGroups(picker,custom,jobs);
    if(!nextGroups.length){
      nextGroups=[{position:'全部岗位',greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:jobs,images:window.defaultGroupImages()}];
    }
    Store.set('groups',nextGroups);
    window.initJobCustom(false);
  }
  return true;
}

/** 为 review 的重新投递恢复现有岗位列表，不发起 START_COLLECT。 */
function hydrateExistingJobListForRetry(done){
  var currentJobs=Store.get('jobs')||[];
  if(currentJobs.length){
    restoreJobListSnapshot({
      jobs:currentJobs,
      selectedPositions:Store.get('selectedPositions')||[],
      customPositions:Store.get('customPositions')||[],
      greetings:Store.get('greetings')||{}
    });
    done(true);
    return;
  }

  try{
    chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
      if(resp&&resp.success&&restoreJobListSnapshot(resp.state)){done(true);return}
      try{
        chrome.storage.local.get([
          STORAGE_KEYS.SW.JOBS,
          STORAGE_KEYS.SW.GREETINGS,
          STORAGE_KEYS.SW.SELECTED_POSITIONS,
          STORAGE_KEYS.SW.CUSTOM_POSITIONS
        ],function(items){
          done(restoreJobListSnapshot({
            jobs:items[STORAGE_KEYS.SW.JOBS]||[],
            greetings:items[STORAGE_KEYS.SW.GREETINGS]||{},
            selectedPositions:items[STORAGE_KEYS.SW.SELECTED_POSITIONS]||[],
            customPositions:items[STORAGE_KEYS.SW.CUSTOM_POSITIONS]||[]
          }));
        });
      }catch(e){done(false)}
    });
  }catch(e){done(false)}
}

/** 从 review 返回现有 B 页岗位列表，保留岗位和勾选状态，不启动新采集。 */
window.returnToExistingJobListFromReview=function(){
  hydrateExistingJobListForRetry(function(hasJobs){
    Store.set('mode','results');
    Store.set('collecting',false);
    Store.set('sending',false);
    Store.set('progressDone',true);
    Store.set('reviewDismissed',true);
    Store.set('awaitingCollect',false);

    E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
    E.resultsContent.classList.remove('hidden');E.progressSection.classList.add('hidden');
    E.bottomSettings.classList.add('hidden');E.bottomResults.classList.remove('hidden');

    var rp=document.getElementById('reviewPanel');
    if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}

    if(E.btnSend){
      E.btnSend.textContent='一键发送';
      E.btnSend.classList.remove('sending');
      E.btnSend.disabled=false;
      E.btnSend.style.background='';
    }

    if((Store.get('groups')||[]).length&&E.groupedContent&&!E.groupedContent.querySelector('.group-card')){
      window.renderGroupsStable();
    }
    if(!hasJobs&&E.groupedContent){
      E.groupedContent.innerHTML='<div class="empty-positions">当前没有可重新投递的岗位，请返回筛选页重新采集</div>';
    }
    if(window.applyGreetingsToGroups())window.updateAllGreetings();
    window.updResCnt();
    window.syncResumeFileNames&&window.syncResumeFileNames();
  });
};

function completeCollection(){
  if(p1dPollHandle){clearInterval(p1dPollHandle);p1dPollHandle=null;}
  Store.set('progressDone',true);Store.set('collecting',false);
  E.progressSection.classList.add('hidden');
  E.resultsContent.classList.remove('hidden');
  E.bottomResults.classList.remove('hidden');
  window.updResCnt();
  window.syncResumeFileNames&&window.syncResumeFileNames();
}

function updateGreetingProgress(progress){
  var el=document.getElementById('greetingProgress');
  if(!el){
    el=document.createElement('div');
    el.id='greetingProgress';
    el.style.cssText='font-size:11px;color:var(--text-weak);padding:8px 16px 16px;text-align:center';
    if(E.groupedContent)E.groupedContent.insertBefore(el,E.groupedContent.firstChild);
  }
  if(!progress||progress.total===0){el.style.display='none';return}
  el.style.display='';
  if(progress.done>=progress.total){
    el.textContent='招呼语已全部生成';
    el.style.color='var(--green)';
  }else{
    el.textContent='招呼语生成中 ('+progress.done+'/'+progress.total+')...';
    el.style.color='var(--text-weak)';
  }
}

function updateAiScreeningProgress(progress){
  var el=document.getElementById('aiScreeningProgress');
  if(!el){
    el=document.createElement('div');
    el.id='aiScreeningProgress';
    el.style.cssText='font-size:11px;color:var(--text-weak);padding:8px 16px;text-align:center';
    if(E.groupedContent)E.groupedContent.insertBefore(el,E.groupedContent.firstChild);
  }
  if(!progress||progress.total===0){el.style.display='none';return}
  el.style.display='';
  var running=progress.done<progress.total;
  el.textContent=running?'AI筛选中 ('+progress.done+'/'+progress.total+')...':'AI筛选已完成';
  el.style.color=running?'var(--text-weak)':'var(--green)';
  if(E.btnSend){
    E.btnSend.disabled=running;
    if(running)E.btnSend.textContent='AI筛选中';
    else if(!Store.get('sending'))E.btnSend.textContent='一键发送';
  }
}

// ════════════════════════════════════════════════════════════
// STATE UPDATE HANDLER
// ════════════════════════════════════════════════════════════

// Debounced jobs processing — only deep-clone when jobs actually change, skip if identical
function _processJobsUpdate(jobsData){
  _debounceJobsTimer=null;
  // Quick guard: skip heavy processing if jobs data hasn't changed, but still sync greetings
  var curJobs=Store.get('jobs');
  if(curJobs&&curJobs.length===jobsData.length){
    var same=true;
    for(var _i=0;_i<Math.min(curJobs.length,5);_i++){
      if(curJobs[_i].id!==jobsData[_i].id){same=false;break}
      var curAi=curJobs[_i].aiScreen&&curJobs[_i].aiScreen.score;
      var newAi=jobsData[_i].aiScreen&&jobsData[_i].aiScreen.score;
      if(curAi!==newAi||curJobs[_i].checked!==jobsData[_i].checked){same=false;break}
    }
    if(same){
      // Jobs unchanged, but greetings may have been updated (async generation completes)
      if(window.applyGreetingsToGroups())window.updateAllGreetings();
      return;
    }
  }
  var jobs=JSON.parse(JSON.stringify(jobsData));
  jobs.forEach(function(j){if(j.checked===undefined)j.checked=true});
  Store.set('jobs',jobs);

  var existingGroups=Store.get('groups');
  if(existingGroups&&existingGroups.length>0){
    // Groups already exist — 增量校正 groups/DOM 与新 Store.jobs（修幽灵卡），再同步招呼语
    window.syncGroupsWithJobs();
    window.applyGreetingsToGroups();
    window.updateAllGreetings();
  }else{
    // First-time group construction
    Store.set('groupExpanded',{});
    var _picker=Store.get('selectedPositions')||[];
    var _custom=Store.get('customPositions')||[];
    var selPos=_picker.concat(_custom);
    var groups;
    if(selPos.length){
      groups=window.prepareGroups(_picker,_custom,jobs);
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }else if(Store.get('mode')==='results'){
      groups=[{position:'全部岗位',greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:jobs,images:window.defaultGroupImages()}];
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }
    // Always render when groups are first-constructed (progressDone may be set by completeCollection before debounce fires)
    if(Store.get('mode')==='results'){
      window.renderGroupsStable();
    }
  }
}

function startBPagePollFallback(){
  if(p1dPollHandle)return;
  p1dPollHandle=setInterval(function(){
    try{
      chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
        if(chrome.runtime.lastError)return;
        if(resp&&resp.success&&resp.state){
          handleStateUpdate(resp.state);
          if(resp.state.phase==='ready'){
            clearInterval(p1dPollHandle);
            p1dPollHandle=null;
          }
        }
      });
    }catch(e){}
  },500);
}

function handleStateUpdate(state){
  var mode=Store.get('mode');

  // B 页无缓存：刚进 B 页(awaitingCollect)时本次采集还没开始，SW 可能仍在广播上一次已完成的
  // 采集结果。在见到本次采集的 'collecting' 信号前一律不渲染——保持骨架加载态，杜绝旧数据回填。
  // startCollect 会同步 phase='collecting'+pushState，故 popup 必先收到 'collecting' 再收到新 'ready'。
  if(Store.get('awaitingCollect')){
    if(state.phase==='collecting'){Store.set('awaitingCollect',false);}
    else{return;}
  }

  // Phase recovery (popup reopened mid-flow)
  // 排除 'review'：投完的旧批 state 不该把用户从 A 页拽回 B 页（review 由下方专门分支处理）
  if(mode==='settings'&&state.phase&&state.phase!=='idle'&&state.phase!=='review'){
    Store.set('mode','results');
    Store.set('collecting',state.phase==='collecting');
    E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
    E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
    E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
    E.progressFill.style.width='0%';
  }

  // Update Store from incoming state
  if(state.selectedPositions&&state.selectedPositions.length)Store.set('selectedPositions',state.selectedPositions);
  if(state.customPositions)Store.set('customPositions',state.customPositions);
  if(state.greetings)Store.set('greetings',state.greetings);
  if(state.aiScreeningProgress)updateAiScreeningProgress(state.aiScreeningProgress);

  // 排除 'review'：投完的旧批 state.jobs 不该重渲 B 页岗位列表/底部计数（这是 18→3 残留的根）
  if(state.jobs&&state.jobs.length&&state.phase!=='review'){
    // 首次加载（groups 不存在）立即渲染，跳过 debounce。后续采集期间的增量更新才 debounce。
    var existingGroups=Store.get('groups');
    if(!existingGroups||!existingGroups.length){
      _processJobsUpdate(state.jobs);
    }else{
      if(_debounceJobsTimer)clearTimeout(_debounceJobsTimer);
      _debounceJobsTimer=setTimeout(function(){_processJobsUpdate(state.jobs)},300);
    }
  }else if(state.greetings&&Store.get('groups')&&Store.get('groups').length&&Store.get('mode')==='results'){
    if(window.applyGreetingsToGroups())window.updateAllGreetings();
  }

  if(state.phase==='ready'&&Store.get('mode')==='results'&&!Store.get('progressDone')){completeCollection()}

  // Empty 兜底：phase=ready 但 jobs=[] → 替换 skeleton 为空态文案，隐藏投递按钮
  if(state.phase==='ready'&&Array.isArray(state.jobs)&&state.jobs.length===0&&Store.get('mode')==='results'){
    if(E.groupedContent)E.groupedContent.innerHTML='<div class="empty-positions">没有符合筛选条件的未投岗位</div>';
    if(E.bottomResults)E.bottomResults.classList.add('hidden');
  }

  // Restore sending progress (popup reopened during send)
  if(state.phase==='sending'){
    Store.set('sending',true);
    E.bottomResults.classList.remove('hidden');
    E.btnSend.textContent='停止发送';E.btnSend.classList.add('sending');E.btnSend.disabled=false;
    if(state.sendProgress){
      var sp=state.sendProgress;
      E.progressText.textContent='正在投递 ('+sp.sent+'/'+sp.total+')...';
      E.progressSub.textContent='';
      E.progressFill.style.width=sp.total>0?Math.min(Math.round(sp.sent/sp.total*100),100)+'%':'0%';
    }
  }

  // CAPTCHA 暂停发送
  if(state.phase==='captcha_paused'){
    Store.set('sending',false);
    E.btnSend.textContent='一键发送';
    E.btnSend.classList.remove('sending');
    E.btnSend.disabled=false;
    E.btnSend.style.background='';
    if(E.bottomResults){E.bottomResults.classList.remove('hidden')}
    showCaptchaWarning();
  }

  if(state.phase==='review'&&state.sendResults&&state.sendResults.length){
    Store.set('lastReview',{sendResults:state.sendResults,duration:state.sendDuration||0,missedCount:(state._v6MissedJobs||[]).length});
    updateLastReviewEntry();
  }

  // 仅结果流程中自动展示 review；设置页里的旧结果只通过显式入口查看。
  if(state.phase==='review'&&Store.get('mode')==='results'&&!Store.get('reviewDismissed')){
    renderReview(state.sendResults||[],state.sendDuration||0,(state._v6MissedJobs||[]).length);
    E.resultsContent.classList.add('hidden');
    E.progressSection.classList.add('hidden');
    E.bottomResults.classList.add('hidden');
    var rp=document.getElementById('reviewPanel');
    if(rp)rp.style.display='';
  }
}

// ── CAPTCHA 暂停提示 ──
function showCaptchaWarning(){
  var existing=document.getElementById('captchaWarning');
  if(existing)return;
  var warning=document.createElement('div');
  warning.id='captchaWarning';
  warning.className='captcha-warning fade-in';
  warning.innerHTML=
    '<div class="captcha-warning-icon">!</div>'+
    '<div class="captcha-warning-title">检测到验证码，发送已暂停</div>'+
    '<div class="captcha-warning-sub">请在 BOSS 直聘页面手动完成验证后，点击继续发送</div>'+
    '<button class="btn btn-primary" id="resumeSendBtn">继续发送</button>';
  var ps=E.progressSection;
  if(ps&&ps.parentNode){
    ps.parentNode.insertBefore(warning,ps.nextSibling);
  }else{
    E.resultsPanel.appendChild(warning);
  }
  document.getElementById('resumeSendBtn').addEventListener('click',function(){
    var jobs=Store.get('jobs')||[];
    var jobIds=jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
    try{
      chrome.runtime.sendMessage({type:MSG.START_SEND,jobIds:jobIds},function(resp){
        var w=document.getElementById('captchaWarning');
        if(resp&&resp.success){
          if(w)w.remove();
          Store.set('sending',true);
          E.btnSend.textContent='停止发送';
          E.btnSend.classList.add('sending');
          E.btnSend.disabled=false;
          E.progressText.textContent='正在继续投递...';
          E.progressSub.textContent='';
        }else{
          E.progressText.textContent='继续投递失败';
          E.progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';
        }
      });
    }catch(e){
      E.progressText.textContent='继续投递失败';
      E.progressSub.textContent='扩展上下文异常，请刷新页面重试';
    }
  });
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

function init(){
  if(typeof TAG_DATA==='undefined'){
    console.warn('TAG_DATA not loaded, attempting dynamic load...');
    var appEl=document.getElementById('app');
    if(!appEl)return;
    appEl.innerHTML='<div style="padding:40px;text-align:center;color:#666"><p>正在加载标签数据...</p></div>';
    var script=document.createElement('script');
    script.src='../content/tag-data.js';
    script.onload=function(){
      if(typeof TAG_DATA!=='undefined'){init()}
      else{appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'}
    };
    script.onerror=function(){appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'};
    document.head.appendChild(script);
    return;
  }

  initDomRefs();

  // 诊断包：popup 打开事件（USER_EVENT）
  try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','popup/侧边栏打开')}catch(_){}

  // A page initial render
  window.renderCityChips('');
  window.renderSettings();
  window.renderResumeImages();

  // Restore resume images + filter state from storage (merged single call)
  try{chrome.storage.local.get(['resumeImages',STORAGE_KEYS.UI.FILTER_STATE],function(r){
    // Resume images
    var stored=r.resumeImages||[];
    stored.forEach(function(it){
      var thumbSrc=it.thumb||(it.data?arrayBufferToDataUrl(it.data,it.type||'image/jpeg'):null);
      if(!it.data&&!thumbSrc)return;
      var images=Store.get('resumeImages')||[];
      var entry={src:thumbSrc||it.data,name:it.name,id:it.id||Date.now()+'_'+Math.random().toString(36).slice(2,6)};
      if(it.fullSrc)entry.fullSrc=it.fullSrc;
      else if(it.data)entry.fullSrc=arrayBufferToDataUrl(it.data,it.type||'image/jpeg');
      images.push(entry);
      Store.set('resumeImages',images);
    });
    if(stored.length)window.refreshBImages();
    // Filter state
    var filterState=r[STORAGE_KEYS.UI.FILTER_STATE];
    if(filterState){
      if(filterState.selectedCities&&filterState.selectedCities.length)Store.set('selectedCities',filterState.selectedCities);
      if(filterState.selectedPositions)Store.set('selectedPositions',filterState.selectedPositions);
      if(filterState.customPositions)Store.set('customPositions',filterState.customPositions);
      if(filterState.hrActiveFilter)Store.set('hrActiveFilter',filterState.hrActiveFilter);
      if(filterState.selectedIndustries)Store.set('selectedIndustries',filterState.selectedIndustries);
      if(filterState.workAreas)Store.set('workAreas',filterState.workAreas);
      if(filterState.jobTypes)Store.set('jobTypes',filterState.jobTypes);
      if(filterState.salaryRanges)Store.set('salaryRanges',filterState.salaryRanges);
      if(filterState.experience)Store.set('experience',filterState.experience);
      if(filterState.education)Store.set('education',filterState.education);
      if(filterState.companySizes)Store.set('companySizes',filterState.companySizes);
      if(filterState.fundingStages)Store.set('fundingStages',filterState.fundingStages);
      window.renderCityChips('');
      window.renderChipSecs();
      window.renderSettings();
    }
  })}catch(e){}

  // Load state from background
  try{
    chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
      if(resp&&resp.success&&resp.state)handleStateUpdate(resp.state);
    });
  }catch(e){}

  // Init event delegation
  window.initEventsA();
  window.initEventsB();
  hydrateLastReviewEntry();

  // ── Settings overlay events ──
  if(E.btnViewLastReview)E.btnViewLastReview.addEventListener('click',openLastReview);
  function showSettings(){E.settingsOverlay.classList.remove('hidden')}
  function hideSettings(){E.settingsOverlay.classList.add('hidden')}
  E.gearBtn.addEventListener('click',showSettings);
  E.settingsClose.addEventListener('click',hideSettings);
  E.settingsOverlay.addEventListener('click',function(e){
    if(e.target===E.settingsOverlay)hideSettings();
  });

  // ── Chrome message listener ──
  if(typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.onMessage){
    chrome.runtime.onMessage.addListener(function(msg){
      if(msg.type===MSG.COLLECT_CITY_PROGRESS&&msg.progress){
        var p=msg.progress;
        E.progressText.textContent='已完成 '+p.completed+'/'+p.total+' 个城市';
        E.progressSub.textContent='已收集 '+p.jobsCollected+' 个岗位';
      }
      if(msg.type===MSG.COLLECT_PROGRESS){
        window.updateProgress(msg.collected||0,msg.total||0,msg.statusText,msg.statusSub);
      }
      if(msg.type===MSG.EXTRACT_PROGRESS){
        // v6 阶段1：搜索页批量提取HR信息进度
        // msg 包含 { done, total, extracted }
        if(window.updateProgress){
          window.updateProgress(msg.extracted,msg.total,'正在提取HR信息');
        }
      }
      if(msg.type===MSG.STATE_UPDATE&&msg.state){
        handleStateUpdate(msg.state);
        if(msg.state.greetingProgress)updateGreetingProgress(msg.state.greetingProgress);
      }
      if(msg.type===MSG.SEND_PROGRESS){
        if(msg.progress){
          var p=msg.progress;
          E.progressText.textContent='正在发送 ('+p.sent+'/'+p.total+')...';
          E.progressFill.style.width=p.total>0?Math.min(Math.round(p.sent/p.total*100),100)+'%':'0%';
        }
      }
      if(msg.type===MSG.SEND_COMPLETE){
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='已发送完成';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=true;
          E.btnSend.style.background='var(--green)';
          window.renderReview(msg.results||[],msg.duration,msg.missedCount||0);
        }
      }
      if(msg.type===MSG.GREETING_AUTO_ENABLED){
        // pre-flight 自动开启了 BOSS 打招呼开关：投递照常，给一条非阻断提示。
        // 不写 progressSub（EXTRACT_PROGRESS→updateProgress 几秒内会覆盖它），独立 notice 块仿 captchaWarning 插法。
        if(!document.getElementById('greetingAutoNotice')){
          var gn=document.createElement('div');
          gn.id='greetingAutoNotice';
          gn.className='fade-in';
          gn.style.cssText='margin:8px 0;padding:8px 12px;background:#f0f9f4;color:#1a7f4b;border-radius:8px;font-size:12px;line-height:1.5;';
          gn.textContent='已为你自动开启 BOSS『自动打招呼』功能（投递必需）';
          if(E.progressSection&&E.progressSection.parentNode){
            E.progressSection.parentNode.insertBefore(gn,E.progressSection);
          }
        }
      }
      if(msg.type===MSG.ERROR){
        // SW 的 ERROR 消息字段键不统一：收集类用 message，发送类(phase:'sending')用 error。
        // 统一兜底读 message||error，避免真错误被吞成「请重试」。
        var _errText=msg.message||msg.error;
        if(Store.get('mode')==='results'&&!Store.get('progressDone')){
          E.progressText.textContent='收集过程中出现错误';
          E.progressSub.textContent=_errText||'请重试';
        }
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='一键发送';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=false;
          E.btnSend.style.background='';
          E.progressText.textContent='发送失败';
          E.progressSub.textContent=_errText||'请重试';
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded',init);

// ═══ 调试桥：主对话通过 postMessage 操控 popup ═══
// 注意：popup HTML 中没有 tab 按钮，页面切换通过 toSettings / toResults / renderReview 函数实现
(function(){
  // 辅助：判断当前可见页面
  function getCurrentPage(){
    var sp=document.getElementById('settingsPanel');
    var rp=document.getElementById('resultsPanel');
    var rv=document.getElementById('reviewPanel');
    if(rv&&rv.style.display!=='none'&&rv.innerHTML.trim())return'Review';
    if(rp&&!rp.classList.contains('hidden'))return'B';
    if(sp&&!sp.classList.contains('hidden'))return'A';
    return'unknown';
  }

  window.addEventListener('message',function(event){
    if(!event.data||!event.data.type)return;
    var cmd=event.data.type;
    var result={};

    try{
      switch(cmd){
        case 'POPUP_SWITCH_TAB':{
          var tab=event.data.tab;
          if(tab==='A'&&typeof window.toSettings==='function'){
            window.toSettings();
            result={currentTab:'A',switched:true};
          }else if(tab==='B'&&typeof window.toResults==='function'){
            window.toResults();
            result={currentTab:'B',switched:true};
          }else if(tab==='Review'){
            var rv=document.getElementById('reviewPanel');
            if(rv&&rv.innerHTML.trim()){
              E.resultsContent.classList.add('hidden');
              E.bottomResults.classList.add('hidden');
              E.progressSection.classList.add('hidden');
              rv.style.display='';
              result={currentTab:'Review',switched:true};
            }else{
              result={error:'Review page has no content (send not completed)'};
            }
          }else{
            result={error:'Unknown tab: '+tab};
          }
          // 写入 data-popup-state 供主对话读取
          document.documentElement.setAttribute('data-popup-state',JSON.stringify({
            currentTab:getCurrentPage(),
            rendered:true
          }));
          break;
        }

        case 'POPUP_GET_STATE':{
          result={
            currentTab:getCurrentPage(),
            mode:Store.get('mode'),
            collecting:Store.get('collecting'),
            sending:Store.get('sending'),
            progressDone:Store.get('progressDone'),
            jobsCount:(Store.get('jobs')||[]).length,
            groupsCount:(Store.get('groups')||[]).length,
            selectedCities:(Store.get('selectedCities')||[]).length,
            selectedPositions:Store.get('selectedPositions')||[],
            progressText:E.progressText?E.progressText.textContent:'',
            progressSub:E.progressSub?E.progressSub.textContent:'',
            bodyHTML:document.body?document.body.innerHTML.substring(0,500):''
          };
          // 检测验证码暂停
          if(document.getElementById('captchaWarning'))result.warning='captcha';
          document.documentElement.setAttribute('data-popup-state',JSON.stringify(result));
          break;
        }

        case 'POPUP_TRIGGER_ACTION':{
          var action=event.data.action;
          if(action==='START_COLLECT'){
            var btn=document.getElementById('btnCollect');
            if(btn){btn.click();result={action:'START_COLLECT',triggered:true}}
            else result={action:'START_COLLECT',triggered:false,error:'Button #btnCollect not found'};
          }else if(action==='START_SEND'){
            var btn=document.getElementById('btnSend');
            if(btn){btn.click();result={action:'START_SEND',triggered:true}}
            else result={action:'START_SEND',triggered:false,error:'Button #btnSend not found'};
          }else if(action==='STOP_COLLECT'){
            try{
              chrome.runtime.sendMessage({type:MSG.STOP_COLLECT});
              result={action:'STOP_COLLECT',triggered:true};
            }catch(e){result={action:'STOP_COLLECT',triggered:false,error:e.message}};
          }else if(action==='STOP_SEND'){
            var btn=document.getElementById('btnSend');
            if(btn&&btn.classList.contains('sending')){
              btn.click();
              result={action:'STOP_SEND',triggered:true};
            }else if(btn){
              result={action:'STOP_SEND',triggered:false,error:'Not currently sending (btnSend has no .sending class)'};
            }else{
              result={action:'STOP_SEND',triggered:false,error:'Button #btnSend not found'};
            }
          }else{
            result={error:'Unknown action: '+action};
          }
          // 立即写一个中间结果
          document.documentElement.setAttribute('data-action-result',JSON.stringify(result));
          // 延迟 1 秒后读取 storage 并写入最终结果
          var act=action;
          setTimeout(function(){
            try{
              chrome.storage.local.get(null,function(items){
                var sr;
                try{sr=items[STORAGE_KEYS.SW.STATE]?JSON.parse(items[STORAGE_KEYS.SW.STATE]):null}catch(ex){}
                document.documentElement.setAttribute('data-action-result',JSON.stringify({
                  action:act,
                  triggered:result.triggered,
                  swPhase:items[STORAGE_KEYS.SW.PHASE]||null,
                  swState:sr,
                  mode:Store.get('mode'),
                  collecting:Store.get('collecting'),
                  sending:Store.get('sending'),
                  progressDone:Store.get('progressDone')
                }));
              });
            }catch(e){
              document.documentElement.setAttribute('data-action-result',JSON.stringify({error:e.message}));
            }
          },1000);
          // POPUP_TRIGGER_ACTION 不落到通用的 data-popup-result 写入
          return;
        }

        default:
          result={error:'Unknown command: '+cmd};
      }
    }catch(e){
      result={error:e.message};
    }

    document.documentElement.setAttribute('data-popup-result',JSON.stringify(result));
  });
})();
