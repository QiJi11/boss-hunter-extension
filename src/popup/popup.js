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
var pendingCompositeImportDraft=null;
var popupStorageListenerBound=false;
var SettingsBackupApi=window.SettingsBackup||{};
var FILTER_STATE_KEY=SettingsBackupApi.FILTER_STATE_KEY||'ui:filterState';
var AI_CONFIG_KEY=SettingsBackupApi.AI_CONFIG_KEY||'sw:aiConfig';
var DEFAULT_AI_CONFIG=SettingsBackupApi.DEFAULT_AI_CONFIG||{
  provider:'openai-compatible',
  baseUrl:'https://api.openai.com/v1',
  apiKey:'',
  model:'gpt-4.1-mini',
  scoreThreshold:60
};
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
  E.excludeKeywordInput=$('#excludeKeywordInput');E.addExcludeKeywordBtn=$('#addExcludeKeywordBtn');E.excludeKeywordTags=$('#excludeKeywordTags');
  E.skipHistoryToggle=$('#skipHistoryToggle');
  E.aiFilterBox=$('#aiFilterBox');E.aiFilterPrompt=$('#aiFilterPrompt');
  E.aiFilterGenerateBtn=$('#aiFilterGenerateBtn');E.aiFilterApplyBtn=$('#aiFilterApplyBtn');
  E.aiFilterDiscardBtn=$('#aiFilterDiscardBtn');E.aiFilterStatus=$('#aiFilterStatus');E.aiFilterPreview=$('#aiFilterPreview');
  E.sendGreetingToggle=$('#sendGreetingToggle');
  E.bottomSettings=$('#bottomSettings');E.bottomResults=$('#bottomResults');
  E.btnReset=$('#btnReset');E.btnCollect=$('#btnCollect');E.btnSend=$('#btnSend');
  E.btnViewLastReview=$('#btnViewLastReview');
  E.resultCountNum=$('#resultCountNum');E.resultCountTotal=$('#resultCountTotal');
  E.hiddenFileInput=$('#hiddenFileInput');E.hiddenFileInputB=$('#hiddenFileInputB');E.resumeThumbArea=$('#resumeThumbArea');
  E.progressSection=$('#progressSection');E.progressFill=$('#progressFill');
  E.progressText=$('#progressText');E.progressSub=$('#progressSub');
  E.resultsContent=$('#resultsContent');E.groupedContent=$('#groupedContent');
  E.compositeBtn=$('#compositeBtn');E.compositeOverlay=$('#compositeOverlay');E.compositeClose=$('#compositeClose');
  E.compositeOpenOptionsBtn=$('#compositeOpenOptionsBtn');
  E.compositeAiProvider=$('#compositeAiProvider');E.compositeAiBaseUrl=$('#compositeAiBaseUrl');E.compositeAiApiKey=$('#compositeAiApiKey');
  E.compositeAiModel=$('#compositeAiModel');E.compositeAiScoreThreshold=$('#compositeAiScoreThreshold');E.compositeTextResume=$('#compositeTextResume');
  E.compositeTestBtn=$('#compositeTestBtn');E.compositeSaveBtn=$('#compositeSaveBtn');E.compositeStatus=$('#compositeStatus');
  E.compositeExportBtn=$('#compositeExportBtn');E.compositeImportBtn=$('#compositeImportBtn');E.compositeImportFileInput=$('#compositeImportFileInput');
  E.compositeImportStatus=$('#compositeImportStatus');E.compositeImportPreviewCard=$('#compositeImportPreviewCard');
  E.compositeImportPreviewMeta=$('#compositeImportPreviewMeta');E.compositeImportPreviewSummary=$('#compositeImportPreviewSummary');
  E.compositeConfirmImportBtn=$('#compositeConfirmImportBtn');E.compositeCancelImportBtn=$('#compositeCancelImportBtn');
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
  updateAiNotConfiguredHint();
  if(window.renderSummaryPanel)window.renderSummaryPanel();
  window.updResCnt();
  window.syncResumeFileNames&&window.syncResumeFileNames();
}

function updateAiFilterAssistantState(){
  if(!E.aiFilterGenerateBtn||!E.aiFilterPrompt)return;
  var hasAi=!!(E.compositeBtn&&E.compositeBtn.classList.contains('configured'));
  E.aiFilterGenerateBtn.disabled=!hasAi;
  E.aiFilterPrompt.disabled=!hasAi;
  if(!hasAi){
    if(E.aiFilterStatus){
      E.aiFilterStatus.textContent='未配置 AI，暂时不能生成筛选建议';
      E.aiFilterStatus.className='ai-filter-status';
    }
    return;
  }
  if(E.aiFilterStatus&&/未配置 AI/.test(E.aiFilterStatus.textContent||'')){
    E.aiFilterStatus.textContent='';
    E.aiFilterStatus.className='ai-filter-status';
  }
}

function updateAiNotConfiguredHint(){
  if(!E.groupedContent)return;
  var jobs=Store.get('jobs')||[];
  var hasJobs=jobs.length>0;
  var hasAi=jobs.some(function(job){return !!(job&&job.aiScreen)});
  var el=document.getElementById('aiNotConfiguredHint');
  if(!hasJobs||hasAi){
    if(el)el.remove();
    return;
  }
  if(!el){
    el=document.createElement('div');
    el.id='aiNotConfiguredHint';
    el.style.cssText='font-size:12px;color:var(--text-weak);padding:8px 16px;text-align:center;background:#f9fafb;border-bottom:1px solid var(--border-light)';
    E.groupedContent.insertBefore(el,E.groupedContent.firstChild);
  }
  el.textContent='未配置 AI，当前仅展示普通岗位列表；点击顶部完整设置可开启岗位匹配判断';
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
  var hint=document.getElementById('aiNotConfiguredHint');
  if(hint)hint.remove();
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
    else if(!Store.get('sending')){
      E.btnSend.textContent='一键发送';
      if(window.updResCnt)window.updResCnt();
    }
  }
}

function setJobAnalysisExportStatus(text,cls){
  var el=document.getElementById('jobAnalysisExportStatus');
  if(!el)return;
  el.textContent=text||'';
  el.className='job-analysis-export-status '+(cls||'');
}

function syncJobAnalysisCustomRange(){
  var rangeEl=document.getElementById('jobAnalysisRange');
  var startEl=document.getElementById('jobAnalysisStartDate');
  var endEl=document.getElementById('jobAnalysisEndDate');
  var custom=rangeEl&&rangeEl.value==='custom';
  if(startEl)startEl.classList.toggle('hidden',!custom);
  if(endEl)endEl.classList.toggle('hidden',!custom);
}

function readJobAnalysisRangeOptions(){
  var rangeEl=document.getElementById('jobAnalysisRange');
  var startEl=document.getElementById('jobAnalysisStartDate');
  var endEl=document.getElementById('jobAnalysisEndDate');
  return {
    type:rangeEl?rangeEl.value:'last7',
    startDate:startEl?startEl.value:'',
    endDate:endEl?endEl.value:'',
    aiBatchOverview:Store.get('aiBatchOverview')||null
  };
}

async function exportJobAnalysis(){
  var btn=document.getElementById('btnExportJobAnalysis');
  if(!window.JobAnalysisExport||typeof getJobRecords!=='function'){
    setJobAnalysisExportStatus('岗位分析导出不可用','error');
    return;
  }
  if(btn)btn.disabled=true;
  setJobAnalysisExportStatus('正在导出...','');
  try{
    var records=await getJobRecords();
    var payload=window.JobAnalysisExport.buildJobAnalysisExport(records,readJobAnalysisRangeOptions());
    window.JobAnalysisExport.downloadJobAnalysisExport(payload);
    setJobAnalysisExportStatus('已导出 '+payload.summary.total+' 条','success');
  }catch(e){
    setJobAnalysisExportStatus('导出失败: '+(e&&e.message||e),'error');
  }finally{
    if(btn)btn.disabled=false;
  }
}

function openJobAnalysisImportPicker(){
  var input=document.getElementById('jobAnalysisImportFileInput');
  if(!input){
    setJobAnalysisExportStatus('岗位分析导入入口不可用','error');
    return;
  }
  input.click();
}

async function importJobAnalysisFile(file){
  var btn=document.getElementById('btnImportJobAnalysis');
  if(!window.JobAnalysisExport||typeof saveJobRecords!=='function'){
    setJobAnalysisExportStatus('岗位分析导入不可用','error');
    return;
  }
  if(!file)return;
  if(btn)btn.disabled=true;
  setJobAnalysisExportStatus('正在导入...','');
  try{
    var text=await file.text();
    var parsed=JSON.parse(text);
    var records=window.JobAnalysisExport.normalizeJobAnalysisImportPayload(parsed);
    var saved=await saveJobRecords(records);
    setJobAnalysisExportStatus('已导入 '+saved.length+' 条岗位记录','success');
  }catch(e){
    setJobAnalysisExportStatus('导入失败: '+(e&&e.message||e),'error');
  }finally{
    if(btn)btn.disabled=false;
  }
}

function buildBatchOverviewText(){
  var overview=Store.get('aiBatchOverview')||{};
  var coverage=overview.coverage||{};
  function section(title,list){
    var items=Array.isArray(list)?list.filter(Boolean):[];
    return title+'\\n'+(items.length?items.map(function(item){return '- '+item}).join('\\n'):'- 暂无');
  }
  return [
    '整批岗位 AI 总览',
    overview.headline||'',
    '覆盖：已结合 '+Number(coverage.jobsWithJD||0)+'/'+Number(coverage.totalJobs||0)+' 条 JD，剩余 '+Number(coverage.pendingJobs||0)+' 条，已完成 '+Number(coverage.completedBatches||0)+' 批',
    section('优点',overview.good),
    section('缺点',overview.bad),
    section('下次方向',overview.nextFocus),
    section('避坑提醒',overview.pitfalls)
  ].filter(Boolean).join('\\n\\n');
}

async function copyBatchOverview(){
  var text=buildBatchOverviewText();
  try{
    if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(text);
    else{
      var ta=document.createElement('textarea');
      ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
    }
    setJobAnalysisExportStatus('总览已复制','success');
  }catch(e){
    setJobAnalysisExportStatus('复制失败: '+(e&&e.message||e),'error');
  }
}

function generateFilterFromOverview(){
  var overview=Store.get('aiBatchOverview');
  if(!overview){
    setJobAnalysisExportStatus('暂无 AI 总览可生成筛选方案','error');
    return;
  }
  if(E.aiFilterPrompt){
    E.aiFilterPrompt.value=[
      '根据这批岗位总览优化首页筛选：',
      buildBatchOverviewText(),
      '',
      '请减少外包、驻场、培训推广、销售/主播/客服、伪装成开发岗的岗位；保留真正的 AI 应用开发、Agent、RAG、工作流、API 集成、后端落地方向。'
    ].join('\\n');
  }
  if(typeof window.toSettings==='function')window.toSettings();
  if(E.aiFilterGenerateBtn)E.aiFilterGenerateBtn.click();
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
    for(var _i=0;_i<curJobs.length;_i++){
      if(!isSameJobSnapshot(curJobs[_i],jobsData[_i])){same=false;break}
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
  if(Array.isArray(state.excludeKeywords))Store.set('excludeKeywords',state.excludeKeywords);
  if(Object.prototype.hasOwnProperty.call(state,'skipHistoryEnabled'))Store.set('skipHistoryEnabled',state.skipHistoryEnabled!==false);
  if(Object.prototype.hasOwnProperty.call(state,'skipHistoryScope'))Store.set('skipHistoryScope','hr');
  if(state.greetings)Store.set('greetings',state.greetings);
  if(state.aiBatchOverview)Store.set('aiBatchOverview',state.aiBatchOverview);
  if(state.jdHydrationProgress)Store.set('jdHydrationProgress',state.jdHydrationProgress);
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
  if(Store.get('mode')==='results'&&window.renderSummaryPanel)window.renderSummaryPanel();

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

function setCompositeStatus(text,cls){
  if(!E.compositeStatus)return;
  E.compositeStatus.textContent=text||'';
  E.compositeStatus.className='ai-status '+(cls||'');
}

function showCompositeImportStatus(text,cls){
  if(!E.compositeImportStatus)return;
  E.compositeImportStatus.textContent=text||'';
  E.compositeImportStatus.className='composite-status'+(cls?' '+cls:'');
  E.compositeImportStatus.classList.toggle('hidden',!text);
}

function hideCompositeImportPreview(){
  if(!E.compositeImportPreviewCard)return;
  E.compositeImportPreviewCard.classList.add('hidden');
  if(E.compositeImportPreviewMeta)E.compositeImportPreviewMeta.textContent='';
  if(E.compositeImportPreviewSummary)E.compositeImportPreviewSummary.innerHTML='';
}

function renderCompositeImportPreview(draft){
  if(!draft||!E.compositeImportPreviewCard||!SettingsBackupApi.buildImportPreviewItems)return;
  E.compositeImportPreviewCard.classList.remove('hidden');
  if(E.compositeImportPreviewMeta){
    E.compositeImportPreviewMeta.textContent=SettingsBackupApi.buildImportPreviewMeta(draft);
  }
  if(E.compositeImportPreviewSummary){
    E.compositeImportPreviewSummary.innerHTML='';
    SettingsBackupApi.buildImportPreviewItems(draft).forEach(function(item){
      var node=document.createElement('div');
      node.className='composite-preview-item';
      node.innerHTML='<div class="composite-preview-label">'+item.label+'</div><div class="composite-preview-value">'+item.value+'</div>';
      E.compositeImportPreviewSummary.appendChild(node);
    });
  }
}

function readAiConfigFromElements(providerEl,baseUrlEl,apiKeyEl,modelEl,scoreEl){
  return {
    provider:providerEl?providerEl.value.trim():'openai-compatible',
    baseUrl:baseUrlEl?baseUrlEl.value.trim():'',
    apiKey:apiKeyEl?apiKeyEl.value.trim():'',
    model:modelEl?modelEl.value.trim():'',
    scoreThreshold:scoreEl?Number(scoreEl.value||60):60
  };
}

function readCompositeConfig(){
  return readAiConfigFromElements(E.compositeAiProvider,E.compositeAiBaseUrl,E.compositeAiApiKey,E.compositeAiModel,E.compositeAiScoreThreshold);
}

function fillAiFields(target,cfg,textResume){
  if(target.provider)target.provider.value=cfg.provider||'openai-compatible';
  if(target.baseUrl)target.baseUrl.value=cfg.baseUrl||'';
  if(target.apiKey)target.apiKey.value=cfg.apiKey||'';
  if(target.model)target.model.value=cfg.model||'';
  if(target.scoreThreshold)target.scoreThreshold.value=cfg.scoreThreshold||60;
  if(target.textResume)target.textResume.value=textResume||'';
}

function fillAiDrawer(config,textResume){
  var cfg=Object.assign({},DEFAULT_AI_CONFIG,config||{});
  fillAiFields({
    provider:E.compositeAiProvider,
    baseUrl:E.compositeAiBaseUrl,
    apiKey:E.compositeAiApiKey,
    model:E.compositeAiModel,
    scoreThreshold:E.compositeAiScoreThreshold,
    textResume:E.compositeTextResume
  },cfg,textResume);
  if(E.compositeBtn)E.compositeBtn.classList.toggle('configured',!!cfg.apiKey);
  updateAiFilterAssistantState();
}

function loadAiDrawerConfig(done){
  try{
    chrome.storage.local.get(['apiKey','textResume',AI_CONFIG_KEY],function(items){
      var cfg=Object.assign({},DEFAULT_AI_CONFIG,items[AI_CONFIG_KEY]||{});
      if(items.apiKey&&!cfg.apiKey)cfg.apiKey=items.apiKey;
      fillAiDrawer(cfg,items.textResume||'');
      if(done)done(cfg);
    });
  }catch(e){
    setCompositeStatus('读取 AI 设置失败: '+e.message,'error');
  }
}

function isSameJobSnapshot(curJob,newJob){
  if(!curJob||!newJob)return false;
  if(curJob.id!==newJob.id)return false;
  var curAi=curJob.aiScreen&&curJob.aiScreen.score;
  var newAi=newJob.aiScreen&&newJob.aiScreen.score;
  if(curAi!==newAi)return false;
  if(curJob.checked!==newJob.checked)return false;
  if((curJob.detail||'')!==(newJob.detail||''))return false;
  if((curJob.desc||'')!==(newJob.desc||''))return false;
  if((curJob.jdStatus||'')!==(newJob.jdStatus||''))return false;
  if((curJob.jdAttempts||0)!==(newJob.jdAttempts||0))return false;
  if((curJob.jdLastError||'')!==(newJob.jdLastError||''))return false;
  if((curJob.excludeReason||'')!==(newJob.excludeReason||''))return false;
  if((curJob.historySkipReason||'')!==(newJob.historySkipReason||''))return false;
  if((curJob.searchKeyword||'')!==(newJob.searchKeyword||''))return false;
  return true;
}

function saveCompositeConfig(callback){
  var cfg=readCompositeConfig();
  var textResume=E.compositeTextResume?E.compositeTextResume.value.trim():'';
  saveAiConfig(cfg,textResume,setCompositeStatus,callback);
}

function saveAiConfig(cfg,textResume,statusSetter,callback){
  try{
    chrome.runtime.sendMessage({type:MSG.SAVE_AI_CONFIG,config:cfg},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        var err=(resp&&resp.error)||chrome.runtime.lastError?.message||'未知错误';
        statusSetter('保存失败: '+err,'error');
        if(callback)callback(false);
        return;
      }
      chrome.storage.local.set({apiKey:cfg.apiKey},function(){
        if(chrome.runtime.lastError){
          statusSetter('保存失败: '+chrome.runtime.lastError.message,'error');
          if(callback)callback(false);
          return;
        }
        SettingsBackupApi.applySnapshotToStorage({
          textResume:textResume,
          aiConfig:cfg
        }).then(function(){
        fillAiDrawer(cfg,textResume);
        statusSetter('AI 设置已保存','success');
        if(callback)callback(true);
        }).catch(function(errApply){
          statusSetter('保存失败: '+errApply.message,'error');
          if(callback)callback(false);
        });
      });
    });
  }catch(e){
    statusSetter('保存失败: '+e.message,'error');
    if(callback)callback(false);
  }
}

function wireCompositeDrawer(){
  if(!E.compositeBtn||!E.compositeOverlay)return;
  function showComposite(){
    pendingCompositeImportDraft=null;
    hideCompositeImportPreview();
    setCompositeStatus('','');
    showCompositeImportStatus('','');
    loadAiDrawerConfig();
    E.compositeOverlay.classList.remove('hidden');
  }
  function hideComposite(){E.compositeOverlay.classList.add('hidden')}
  E.compositeBtn.addEventListener('click',showComposite);
  if(E.compositeClose)E.compositeClose.addEventListener('click',hideComposite);
  E.compositeOverlay.addEventListener('click',function(e){
    if(e.target===E.compositeOverlay)hideComposite();
  });
  if(E.compositeOpenOptionsBtn)E.compositeOpenOptionsBtn.addEventListener('click',function(){
    openFullOptionsPage();
  });
  if(E.compositeSaveBtn)E.compositeSaveBtn.addEventListener('click',function(){
    E.compositeSaveBtn.disabled=true;
    setCompositeStatus('正在保存...','');
    saveCompositeConfig(function(){
      E.compositeSaveBtn.disabled=false;
    });
  });
  if(E.compositeTestBtn)E.compositeTestBtn.addEventListener('click',function(){
    E.compositeTestBtn.disabled=true;
    setCompositeStatus('正在测试 AI 连接...','');
    chrome.runtime.sendMessage({type:MSG.TEST_AI_CONFIG,config:readCompositeConfig()},function(resp){
      E.compositeTestBtn.disabled=false;
      if(chrome.runtime.lastError||!resp||!resp.success){
        setCompositeStatus('AI 连接失败: '+((resp&&resp.error)||chrome.runtime.lastError?.message||'未知错误'),'error');
        return;
      }
      setCompositeStatus('AI 连接成功','success');
    });
  });
  if(E.compositeExportBtn)E.compositeExportBtn.addEventListener('click',function(){
    E.compositeExportBtn.disabled=true;
    showCompositeImportStatus('正在导出配置...','');
    SettingsBackupApi.readBackupSnapshot().then(function(snapshot){
      downloadBackupSnapshot(snapshot);
      showCompositeImportStatus('配置已导出','success');
    }).catch(function(err){
      showCompositeImportStatus('导出失败: '+err.message,'error');
    }).finally(function(){
      E.compositeExportBtn.disabled=false;
    });
  });
  if(E.compositeImportBtn&&E.compositeImportFileInput){
    E.compositeImportBtn.addEventListener('click',function(){E.compositeImportFileInput.click()});
    E.compositeImportFileInput.addEventListener('change',function(){
      var file=E.compositeImportFileInput.files&&E.compositeImportFileInput.files[0];
      E.compositeImportFileInput.value='';
      if(!file)return;
      file.text().then(function(text){
        var parsed=JSON.parse(text);
        pendingCompositeImportDraft=SettingsBackupApi.normalizeImportPayload(parsed);
        renderCompositeImportPreview(pendingCompositeImportDraft);
        showCompositeImportStatus('导入文件解析成功，请确认覆盖。','success');
      }).catch(function(err){
        pendingCompositeImportDraft=null;
        hideCompositeImportPreview();
        showCompositeImportStatus('导入失败: '+err.message,'error');
      });
    });
  }
  if(E.compositeConfirmImportBtn)E.compositeConfirmImportBtn.addEventListener('click',function(){
    if(!pendingCompositeImportDraft)return;
    E.compositeConfirmImportBtn.disabled=true;
    if(E.compositeCancelImportBtn)E.compositeCancelImportBtn.disabled=true;
    showCompositeImportStatus('正在写入导入配置...','');
    SettingsBackupApi.applySnapshotToStorage(pendingCompositeImportDraft).then(function(){
      pendingCompositeImportDraft=null;
      hideCompositeImportPreview();
      return hydratePopupFromStorage();
    }).then(function(){
      showCompositeImportStatus('导入完成，当前侧栏已同步最新配置。','success');
    }).catch(function(err){
      showCompositeImportStatus('导入失败: '+err.message,'error');
    }).finally(function(){
      E.compositeConfirmImportBtn.disabled=false;
      if(E.compositeCancelImportBtn)E.compositeCancelImportBtn.disabled=false;
    });
  });
  if(E.compositeCancelImportBtn)E.compositeCancelImportBtn.addEventListener('click',function(){
    pendingCompositeImportDraft=null;
    hideCompositeImportPreview();
    showCompositeImportStatus('已取消导入。','');
  });
}

function openFullOptionsPage(){
  var optionsUrl=chrome.runtime&&chrome.runtime.getURL?chrome.runtime.getURL('src/options/options.html'):'src/options/options.html';
  function fallbackOpen(){
    if(chrome.tabs&&chrome.tabs.create){
      chrome.tabs.create({url:optionsUrl});
      return true;
    }
    return false;
  }
  try{
    if(chrome.runtime&&typeof chrome.runtime.openOptionsPage==='function'){
      chrome.runtime.openOptionsPage(function(){
        if(chrome.runtime.lastError){
          fallbackOpen();
        }
      });
      return;
    }
  }catch(e){
    if(fallbackOpen())return;
  }
  fallbackOpen();
}

function downloadBackupSnapshot(snapshot){
  var blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
  var url=URL.createObjectURL(blob);
  var link=document.createElement('a');
  var stamp=new Date().toISOString().replace(/[:.]/g,'-');
  link.href=url;
  link.download='boss-hunter-backup-'+stamp+'.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function applyResumeImagesToStore(stored){
  var images=[];
  (stored||[]).forEach(function(it){
    var thumbSrc=it.thumb||(it.data?arrayBufferToDataUrl(it.data,it.type||'image/jpeg'):null);
    if(!it.data&&!thumbSrc)return;
    var entry={src:thumbSrc||it.data,name:it.name,id:it.id||Date.now()+'_'+Math.random().toString(36).slice(2,6)};
    if(it.fullSrc)entry.fullSrc=it.fullSrc;
    else if(it.data)entry.fullSrc=arrayBufferToDataUrl(it.data,it.type||'image/jpeg');
    images.push(entry);
  });
  Store.set('resumeImages',images);
  window.renderResumeImages();
  window.refreshBImages();
}

function applyAiStorageState(aiConfig,textResume){
  var cfg=Object.assign({},DEFAULT_AI_CONFIG,aiConfig||{});
  fillAiDrawer(cfg,textResume||'');
}

function applyFilterStateToStore(filterState){
  filterState=typeof normalizeFilterStateDefaults==='function'?normalizeFilterStateDefaults(filterState):filterState;
  Store.set('selectedCities',filterState&&filterState.selectedCities&&filterState.selectedCities.length?filterState.selectedCities:[]);
  Store.set('selectedPositions',filterState&&filterState.selectedPositions?filterState.selectedPositions:[]);
  Store.set('customPositions',filterState&&filterState.customPositions?filterState.customPositions:[]);
  Store.set('hrActiveFilter',filterState&&filterState.hrActiveFilter?filterState.hrActiveFilter:'不限');
  Store.set('selectedIndustries',filterState&&filterState.selectedIndustries?filterState.selectedIndustries:[]);
  Store.set('workAreas',filterState&&filterState.workAreas&&filterState.workAreas.length?filterState.workAreas:['不限']);
  Store.set('jobTypes',filterState&&filterState.jobTypes&&filterState.jobTypes.length?filterState.jobTypes:['不限']);
  Store.set('salaryRanges',filterState&&filterState.salaryRanges&&filterState.salaryRanges.length?filterState.salaryRanges:['不限']);
  Store.set('experience',filterState&&filterState.experience&&filterState.experience.length?filterState.experience:['不限']);
  Store.set('education',filterState&&filterState.education&&filterState.education.length?filterState.education:['不限']);
  Store.set('companySizes',filterState&&filterState.companySizes&&filterState.companySizes.length?filterState.companySizes:['不限']);
  Store.set('fundingStages',filterState&&filterState.fundingStages&&filterState.fundingStages.length?filterState.fundingStages:['不限']);
  Store.set('excludeKeywords',filterState&&Array.isArray(filterState.excludeKeywords)?filterState.excludeKeywords:(typeof DEFAULT_EXCLUDE_KEYWORDS!=='undefined'?DEFAULT_EXCLUDE_KEYWORDS.slice():[]));
  Store.set('skipHistoryEnabled',!filterState||filterState.skipHistoryEnabled!==false);
  Store.set('skipHistoryScope','hr');
  Store.set('sendGreeting',!filterState||typeof filterState.sendGreeting!=='boolean'?true:filterState.sendGreeting);
  window.renderCityChips(E.cityInput&&E.cityInput.value||'');
  window.renderChipSecs();
  window.renderSettings();
  window.renderSendGreetingToggle&&window.renderSendGreetingToggle();
  window.renderExcludeKeywords&&window.renderExcludeKeywords();
  window.renderSkipHistoryToggle&&window.renderSkipHistoryToggle();
}

function hydrateAiSettingsFromStorage(done){
  try{
    chrome.storage.local.get(['apiKey','textResume',AI_CONFIG_KEY],function(items){
      var cfg=Object.assign({},DEFAULT_AI_CONFIG,items[AI_CONFIG_KEY]||{});
      if(items.apiKey&&!cfg.apiKey)cfg.apiKey=items.apiKey;
      applyAiStorageState(cfg,items.textResume||'');
      if(done)done();
    });
  }catch(e){
    if(done)done(e);
  }
}

function hydratePopupFromStorage(done){
  try{
    chrome.storage.local.get(['resumeImages',FILTER_STATE_KEY,'apiKey','textResume',AI_CONFIG_KEY],function(items){
      applyResumeImagesToStore(items.resumeImages||[]);
      applyFilterStateToStore(items[FILTER_STATE_KEY]||null);
      var cfg=Object.assign({},DEFAULT_AI_CONFIG,items[AI_CONFIG_KEY]||{});
      if(items.apiKey&&!cfg.apiKey)cfg.apiKey=items.apiKey;
      applyAiStorageState(cfg,items.textResume||'');
      if(done)done();
    });
  }catch(e){
    if(done)done(e);
  }
}

function bindPopupStorageSync(){
  if(popupStorageListenerBound||!chrome.storage||!chrome.storage.onChanged)return;
  chrome.storage.onChanged.addListener(function(changes,areaName){
    if(areaName!=='local'||!changes)return;

    if(Object.prototype.hasOwnProperty.call(changes,'resumeImages')){
      applyResumeImagesToStore(changes.resumeImages&&changes.resumeImages.newValue||[]);
    }

    if(Object.prototype.hasOwnProperty.call(changes,FILTER_STATE_KEY)){
      applyFilterStateToStore(changes[FILTER_STATE_KEY]?changes[FILTER_STATE_KEY].newValue:null);
    }

    if(
      Object.prototype.hasOwnProperty.call(changes,AI_CONFIG_KEY)||
      Object.prototype.hasOwnProperty.call(changes,'apiKey')||
      Object.prototype.hasOwnProperty.call(changes,'textResume')
    ){
      hydrateAiSettingsFromStorage();
    }
  });
  popupStorageListenerBound=true;
}

function refineCollectErrorText(text){
  var raw=String(text||'').trim();
  if(/_security_check|安全验证|security/i.test(raw)){
    return '请先完成 BOSS 安全验证后再收集';
  }
  return raw||'请重试';
}

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
  updateAiFilterAssistantState();
  window.renderFilterSuggestionPreview&&window.renderFilterSuggestionPreview(Store.get('filterSuggestionDraft'));

  hydratePopupFromStorage();
  bindPopupStorageSync();

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
  wireCompositeDrawer();
  document.addEventListener('change',function(e){
    if(e.target&&e.target.id==='jobAnalysisRange'){
      syncJobAnalysisCustomRange();
      setJobAnalysisExportStatus('','');
    }
  });
  document.addEventListener('click',function(e){
    if(e.target&&e.target.closest&&e.target.closest('#btnExportJobAnalysis')){
      e.preventDefault();
      exportJobAnalysis();
    }
    if(e.target&&e.target.closest&&e.target.closest('#btnImportJobAnalysis')){
      e.preventDefault();
      openJobAnalysisImportPicker();
    }
    if(e.target&&e.target.closest&&e.target.closest('#btnCopyBatchOverview')){
      e.preventDefault();
      copyBatchOverview();
    }
    if(e.target&&e.target.closest&&e.target.closest('#btnApplyOverviewToFilter')){
      e.preventDefault();
      generateFilterFromOverview();
    }
  });
  document.addEventListener('change',function(e){
    if(e.target&&e.target.id==='jobAnalysisImportFileInput'){
      var file=e.target.files&&e.target.files[0];
      e.target.value='';
      importJobAnalysisFile(file);
    }
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
          E.progressSub.textContent=refineCollectErrorText(_errText);
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
