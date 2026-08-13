// ════════════════════════════════════════════════════════════
// 猎职 — Review 页（投递完成汇总）渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/esc (global)

var REVIEW_OUTCOME_LABELS=(window.JobOutcomeFeedback&&window.JobOutcomeFeedback.OUTCOME_LABELS)||{
  replied:'已回复',
  interview:'约面',
  notFit:'不合适',
  noResponse:'暂无回复',
};

function renderOutcomeFeedbackControls(item){
  var jobId=String(item&&item.jobId||'').trim();
  if(!item||item.success!==true||!jobId)return '';
  var buttons=Object.keys(REVIEW_OUTCOME_LABELS).map(function(outcome){
    return '<button type="button" class="review-feedback-btn" data-outcome="'+outcome+'">'
      +esc(REVIEW_OUTCOME_LABELS[outcome])+'</button>';
  }).join('');
  return '<div class="review-feedback" data-outcome-job-id="'+esc(jobId)+'">'
    +'<span class="review-feedback-label">后续结果（仅本机手动标记）</span>'
    +buttons
    +'<button type="button" class="review-feedback-btn" data-outcome="clear" disabled>撤销</button>'
    +'<span class="review-feedback-status" aria-live="polite"></span>'
    +'</div>';
}

function findReviewOutcomeSection(reviewPanel,jobId){
  var sections=reviewPanel.querySelectorAll('.review-feedback');
  for(var i=0;i<sections.length;i++){
    if(sections[i].dataset.outcomeJobId===String(jobId))return sections[i];
  }
  return null;
}

function applyReviewOutcome(reviewPanel,jobId,record){
  var section=findReviewOutcomeSection(reviewPanel,jobId);
  if(!section)return;
  var selected=record&&record.outcome||'';
  section.dataset.currentOutcome=selected;
  var buttons=section.querySelectorAll('.review-feedback-btn');
  for(var i=0;i<buttons.length;i++){
    var button=buttons[i];
    var isClear=button.dataset.outcome==='clear';
    button.disabled=isClear&&!selected;
    button.classList.toggle('selected',button.dataset.outcome===selected);
    button.setAttribute('aria-pressed',button.dataset.outcome===selected?'true':'false');
  }
}

function showReviewOutcomeStatus(reviewPanel,jobId,text){
  var section=findReviewOutcomeSection(reviewPanel,jobId);
  var status=section&&section.querySelector('.review-feedback-status');
  if(status)status.textContent=text||'';
}

function loadReviewOutcomes(reviewPanel,results){
  var jobIds=(results||[]).filter(function(item){
    return item&&item.success===true&&item.jobId!=null;
  }).map(function(item){return String(item.jobId);});
  if(!jobIds.length)return;
  var requestKey=jobIds.join('\u001f');
  reviewPanel._outcomeRequestKey=requestKey;
  chrome.runtime.sendMessage({type:MSG.GET_JOB_OUTCOMES,jobIds:jobIds},function(response){
    if(reviewPanel._outcomeRequestKey!==requestKey||!response||!response.success)return;
    var records=response.records||{};
    jobIds.forEach(function(jobId){applyReviewOutcome(reviewPanel,jobId,records[jobId]||null);});
  });
}

function wireReviewOutcomeActions(reviewPanel){
  if(reviewPanel._outcomeWired)return;
  reviewPanel._outcomeWired=true;
  reviewPanel.addEventListener('click',function(event){
    var button=event.target.closest('.review-feedback-btn');
    if(!button||button.disabled)return;
    var section=button.closest('.review-feedback');
    var jobId=section&&section.dataset.outcomeJobId;
    if(!jobId)return;
    var buttons=section.querySelectorAll('.review-feedback-btn');
    for(var i=0;i<buttons.length;i++)buttons[i].disabled=true;
    showReviewOutcomeStatus(reviewPanel,jobId,'正在保存...');
    chrome.runtime.sendMessage({type:MSG.RECORD_JOB_OUTCOME,jobId:jobId,outcome:button.dataset.outcome},function(response){
      for(var j=0;j<buttons.length;j++)buttons[j].disabled=false;
      if(!response||!response.success){
        applyReviewOutcome(reviewPanel,jobId,section.dataset.currentOutcome?{outcome:section.dataset.currentOutcome}:null);
        showReviewOutcomeStatus(reviewPanel,jobId,'保存失败：'+((response&&response.error)||chrome.runtime.lastError?.message||'无响应'));
        return;
      }
      applyReviewOutcome(reviewPanel,jobId,response.record||null);
      showReviewOutcomeStatus(reviewPanel,jobId,button.dataset.outcome==='clear'?'已撤销':'已保存到本机');
    });
  });
}

window.renderReview=function(sendResults,duration,missedCount){
  var reviewPanel=document.getElementById('reviewPanel');
  if(!reviewPanel)return;

  var missed=missedCount||0; // A1 漏发清单条数（SW finalizeTask 计算：已建联但未发 AI 招呼语+图）
  var results=sendResults||[];
  Store.set('lastReview',{sendResults:results,duration:duration||0,missedCount:missed});
  var successCount=0,failCount=0;
  results.forEach(function(r){
    if(r.success)successCount++;
    else if(!r.alreadyChatted&& !r.skipped)failCount++;
  });

  var total=successCount+failCount;
  // 根据成功率动态显示标题
  var titleText='投递完成';
  var iconColor='var(--green)';
  var iconBg='rgba(5,150,105,.1)';
  if(total>0&&failCount===total){
    titleText='投递失败';
    iconColor='var(--red)';
    iconBg='rgba(220,38,38,.1)';
  }else if(failCount>0){
    titleText='部分成功';
    iconColor='var(--accent)';
    iconBg='rgba(217,119,6,.1)';
  }

  var html='<div class="review-wrapper">'

    // Summary header
    +'<div class="review-summary">'
    +'<div class="review-icon"><svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" fill="'+iconBg+'" stroke="'+iconColor+'" stroke-width="1.5"/><path d="M12 20l6 6 10-10" stroke="'+iconColor+'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'
    +'<div class="review-title">'+titleText+'</div>'
    +'<div class="review-stats">'
    +'投递 <span class="review-stat-num">'+total+'</span> 个岗位：'
    +'成功 <span class="review-stat-num" style="color:#22c55e">'+successCount+'</span> ｜'
    +'失败 <span class="review-stat-num" style="color:#ef4444">'+failCount+'</span>'
    +'</div>'
    +'</div>'

    // 已建联但未确认送达的岗位只提示人工核对，不提供自动补发入口。
    +(missed>0
      ?'<div class="review-missed-hint" style="margin:0 16px 12px;padding:10px 12px;background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.25);border-radius:8px;font-size:12px;color:var(--accent);">'
        +'⚠️ '+missed+' 个岗位状态不确定。请逐岗打开复核，确认失败后再人工补发。'
      +'</div>'
      :'')

    // Group detail cards
    +'<div class="review-groups">';

  // Group by position name
  var groupMap={};
  results.forEach(function(r){
    var pos=r.positionName||'其他';
    if(!groupMap[pos])groupMap[pos]={position:pos,items:[]};
    groupMap[pos].items.push(r);
  });

  var posKeys=Object.keys(groupMap);
  for(var pi=0;pi<posKeys.length;pi++){
    var gg=groupMap[posKeys[pi]];
    var gSuccess=gg.items.filter(function(i){return i.success}).length;
    // 与顶部 failCount 同口径：alreadyChatted/skipped 不计入失败
    var gFail=gg.items.filter(function(i){return !i.success && !i.alreadyChatted && !i.skipped}).length;
    html+='<div class="review-group-card">'
      +'<div class="review-group-header">'
      +'<span class="review-group-title">'+esc(gg.position)+'</span>'
      +'<span class="review-group-stat">'
      +(gSuccess>0?'<span class="review-success">✓</span> ':'')
      +(gFail>0?'<span class="review-fail">✗</span>':'')
      +'</span>'
      +'</div>'
      +'<div class="review-group-items'+(gg.items.length>5?' collapsed':'')+'">';
    for(var ii=0;ii<gg.items.length;ii++){
      var item=gg.items[ii];
      // alreadyChatted=true 视觉勾 + 「已沟通过，跳过」灰色文本（避免与「真成功」视觉相同导致误导）
      var _note=item.alreadyChatted?'已同HR沟通过，跳过':(item.error||'');
      html+='<div class="review-item'+(item.success?' review-item-success':(item.skipped?'':' review-item-fail'))+'">'
        +'<span class="review-item-icon">'+(item.success?'&#10003;':(item.skipped?'&#8211;':'&#10007;'))+'</span>'
        +'<span class="review-item-name">'+esc(item.companyName||'')+'</span>'
        +(_note?'<span class="review-item-error"'+((item.alreadyChatted||item.skipped)?' style="color:#94a3b8"':'')+'>'+esc(_note)+'</span>':'')
        +renderOutcomeFeedbackControls(item)
        +'</div>';
    }
    html+='</div>';
    if(gg.items.length>5){
      html+='<div class="review-expand-toggle" data-total="'+gg.items.length+'">展开全部 '+gg.items.length+' 个</div>';
    }
    html+='</div>';
  }

  html+='</div>' // review-groups

    // Retry button — 回到现有 B 页岗位列表，不触发重新采集
    +'<div class="review-actions">'
    +'<button class="btn btn-primary" id="btnRetryBatch">重新投递</button>'
    +'</div>'

    +'</div>'; // review-wrapper

  reviewPanel.innerHTML=html;

  // Show review panel, hide results
  E.resultsContent.classList.add('hidden');
  E.bottomResults.classList.add('hidden');
  reviewPanel.style.display='';

  // Wire review group items expand/collapse via delegation.
  // 只绑定一次：renderReview 可能因 STATE_UPDATE 多次调用，
  // 重复 addEventListener 会让监听堆叠，偶数次时点击 toggle 互相抵消 → 按钮看似无反应。
  if(!reviewPanel._expandWired){
    reviewPanel._expandWired=true;
    reviewPanel.addEventListener('click',function(e){
      var expand=e.target.closest('.review-expand-toggle');
      if(expand){
        var card=expand.closest('.review-group-card');
        var items=card?card.querySelector('.review-group-items'):null;
        if(items){
          items.classList.toggle('collapsed');
          expand.textContent=items.classList.contains('collapsed')
            ?'展开全部 '+expand.dataset.total+' 个'
            :'收起';
        }
      }
    });
  }
  wireReviewOutcomeActions(reviewPanel);
  loadReviewOutcomes(reviewPanel,results);

  // Wire 「重新投递」→ 回到当前 B 页岗位列表，保留岗位勾选状态，让用户重新选择后再发送。
  var retryBtn=document.getElementById('btnRetryBatch');
  if(retryBtn){
    retryBtn.addEventListener('click',function(){
      Store.set('reviewDismissed',true); // 标记已离开本批 review，handleStateUpdate 不再自动弹回
      reviewPanel.style.display='none';
      reviewPanel.innerHTML='';
      reviewPanel._expandWired=false;
      window.returnToExistingJobListFromReview();
    });
  }

};
