// ════════════════════════════════════════════════════════════
// 猎职 — B 页（结果页）事件委托
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global)
// Depends on: MSG (from constants.js)
// Depends on: render-b.js (window.* functions)

window.initEventsB=function(){
  if(window._eventsBInitialized)return;
  window._eventsBInitialized=true;

  document.addEventListener('click',function(e){
    var retryBtn=e.target.closest('#btnRetryJobDetails');
    if(!retryBtn)return;
    if(retryBtn.disabled)return;
    retryBtn.disabled=true;
    retryBtn.textContent='JD补拉中...';
    chrome.runtime.sendMessage({type:MSG.RETRY_JOB_DETAILS},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        retryBtn.disabled=false;
        retryBtn.textContent='继续补拉 JD';
      }
    });
  });

  // ── Grouped content delegation ──
  E.groupedContent.addEventListener('click',function(e){
    try{
      // Per-job custom image upload
      var jact=e.target.closest('[data-gact="addJobImg"]');
      if(jact){
        var jobId=jact.dataset.jobId;
        var fileInput=document.getElementById('jobFile_'+jobId);
        if(fileInput)fileInput.click();
        return
      }
      // Per-job custom image remove
      var jrem=e.target.closest('.thumb-remove[data-job-img]');
      if(jrem){
        var jid=jrem.dataset.jobImg;
        var idx=parseInt(jrem.dataset.idx);
        var jc=Store.get('jobCustom')||{};
        var entry=jc[jid];
        if(entry&&entry.images&&idx>=0&&idx<entry.images.length){
          entry.images.splice(idx,1);
          Store.set('jobCustom',jc);
          // Re-render this job's thumb area
          var thumbArea=jrem.closest('.univ-thumb-area');
          if(thumbArea)thumbArea.innerHTML=window.renderJobThumbnailsHTML(jid);
        }
        return
      }

      // Greeting actions (rewrite)
      var gact=e.target.closest('[data-gact]');
      if(gact){
        if(gact.dataset.gact==='addImg'){
          // B 页组级添加：入口带组标识 data-ggi，上传只写该组 g.images（无 ggi 时兜底走 A 页全局入口）
          var addGgi=gact.dataset.ggi;
          if(addGgi!==undefined&&E.hiddenFileInputB){
            E.hiddenFileInputB.dataset.ggi=addGgi;
            E.hiddenFileInputB.click();
          }else{
            E.hiddenFileInput.click();
          }
          return
        }
        if(gact.dataset.gact==='addJobImg')return; // handled above
        var gi=parseInt(gact.dataset.g);
        if(isNaN(gi))return;
        var groups=Store.get('groups')||[];
        var g=groups[gi];
        if(!g)return;
        if(gact.dataset.gact==='rewrite'){
          gact.classList.add('spinning');
          var jdSamples=g.jobs.slice(0,5).map(function(j){
            return{title:j.name,tags:j.tags,desc:j.name};
          });
          chrome.runtime.sendMessage({type:MSG.REGENERATE_GREETING,category:g.position,jdSamples:jdSamples},function(resp){
            if(resp&&resp.success&&resp.greeting){
              g.greeting.text=resp.greeting;
              g.greeting.editing=false;
              Store.set('groups',groups);
              window.syncGroupGreeting(gi);
            }
            // Targeted update: refresh greeting display only
            window.updateGroupGreeting(gi);
            gact.classList.remove('spinning');
          });
        }
        return
      }

      // Expand group
      var exp=e.target.closest('.expand-more-jobs');
      if(exp){
        var egi=parseInt(exp.dataset.gi);
        if(!isNaN(egi))window.expandGroup(egi);
        return
      }

      // Click greet-text to edit
      var gt=e.target.closest('.greet-text[data-g]');
      if(gt){
        window.showGreetingEditor(parseInt(gt.dataset.g));
        return
      }

      // Image remove (B page) — 按组删除：只动该组 g.images，不再碰全局 resumeImages/storage
      var rem=e.target.closest('.thumb-remove[data-ggi]');
      if(rem){
        var rgi=parseInt(rem.dataset.ggi);
        var idx=parseInt(rem.dataset.idx);
        if(!isNaN(rgi)&&!isNaN(idx)&&idx>=0){
          var rGroups=Store.get('groups')||[];
          var rg=rGroups[rgi];
          if(rg&&rg.images&&idx<rg.images.length){
            rg.images.splice(idx,1);
            Store.set('groups',rGroups);
            window.refreshGroupImages(rgi);
          }
        }
        return
      }

      // Image lightbox (B page thumbnails) — 组级缩略图用该组 g.images 的 fullSrc
      var thumbImg=e.target.closest('.univ-thumb img');
      if(thumbImg){
        var src=thumbImg.src;
        if(thumbImg.dataset.ggi!==undefined){
          var lGroups=Store.get('groups')||[];
          var lg=lGroups[parseInt(thumbImg.dataset.ggi)];
          var lImg=lg&&lg.images&&lg.images[parseInt(thumbImg.dataset.idx)];
          if(lImg&&lImg.fullSrc)src=lImg.fullSrc;
        }else{
          var gimg=thumbImg.dataset.gimg;
          var images=Store.get('resumeImages')||[];
          var imgData=images[parseInt(gimg)];
          if(imgData&&imgData.fullSrc)src=imgData.fullSrc;
        }
        showImageLightbox(src);
        return
      }

      // Job custom toggle (lazy create)
      var toggle=e.target.closest('.job-custom-toggle');
      if(toggle){
        var id=toggle.dataset.jobId;
        window.toggleJobCustom(id);
        return
      }

      // JD expand/collapse inside job card (stopPropagation so it does not toggle the checkbox)
      var jdToggle=e.target.closest('.job-jd-toggle');
      if(jdToggle){
        e.stopPropagation();
        var jdCard=e.target.closest('.job-jd-preview[data-jd-job-id]');
        if(jdCard){
          jdCard.classList.toggle('open');
          var full=jdCard.querySelector('.job-jd-full');
          var btn=jdCard.querySelector('.job-jd-toggle');
          if(jdCard.classList.contains('open')){
            if(full)full.style.display='block';
            if(btn)btn.textContent='收起';
          }else{
            if(full)full.style.display='none';
            if(btn)btn.textContent='展开';
          }
        }
        return
      }

      // Open BOSS job detail page in a new tab (stopPropagation so it does not toggle the checkbox)
      var jdOpen=e.target.closest('.job-jd-open');
      if(jdOpen){
        e.stopPropagation();
        var jid=jdOpen.dataset.jobId;
        if(jid)chrome.tabs.create({url:'https://www.zhipin.com/job_detail/'+jid+'.html'});
        return
      }

      // Help tip: click ? to open full-size help image in new tab
      var helpTip=e.target.closest('.help-tip');
      if(helpTip){
        var imgUrl=chrome.runtime.getURL('src/popup/auto-reply-help.png');
        var html='<html><head><meta charset="utf-8"><title>自动回复简历说明</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}img{max-width:800px;width:90%;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12)}p{color:#555;font-size:14px;margin-top:16px}</style></head><body><img src="'+imgUrl+'" alt="自动回复说明"><p>帮助您识别 HR 消息中的关键词，进行自动回复附件简历。</p></body></html>';
        var b64=btoa(unescape(encodeURIComponent(html)));
        chrome.tabs.create({ url: 'data:text/html;charset=utf-8;base64,'+b64 });
        return
      }

      // Master checkbox: tri-state toggle for all jobs in group
      var master=e.target.closest('.job-master-checkbox');
      if(master){
        window.toggleGroupMaster(parseInt(master.dataset.masterGi));
        return
      }

      // Job checkbox toggle (skip if click inside custom settings panel)
      var it=e.target.closest('.job-item');
      if(it){
        if(e.target.closest('.job-custom-settings')) return;
        var id=it.dataset.jobId;
        window.toggleJobCheck(id);
      }
    }catch(ex){console.error('groupedContent click:',ex)}
  });

  // Greeting textarea: Enter exits editing
  E.groupedContent.addEventListener('keydown',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));
    }
  });
  E.groupedContent.addEventListener('focusout',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta)window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));
  });

  // Greeting & file name input (live sync)
  E.groupedContent.addEventListener('input',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta){
      var gi=parseInt(ta.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.greeting.text=ta.value;
      Store.set('groups',groups);
      return
    }
    var fn=e.target.closest('.att-name-input[data-g]');
    if(fn){
      var gi=parseInt(fn.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.fileName=fn.value;
      Store.set('groups',groups);
      syncResumeFileNames();
      return
    }
    var inp=e.target.closest('.custom-ta');
    if(inp){
      var id=inp.dataset.jobId;
      var setting=inp.dataset.cs;
      var jc=Store.get('jobCustom')||{};
      var entry=jc[id];
      if(!entry)return;
      if(setting==='greeting')entry.customGreeting=inp.value;
      Store.set('jobCustom',jc);
    }
  });

  // Per-job custom image upload (change event on dynamically created file inputs)
  E.groupedContent.addEventListener('change',function(e){
    var fileInput=e.target.closest('input[type="file"][id^="jobFile_"]');
    if(!fileInput)return;
    var files=fileInput.files;
    if(!files||!files.length)return;
    var jobId=fileInput.id.replace('jobFile_','');
    var jc=Store.get('jobCustom')||{};
    if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
    if(!jc[jobId].images)jc[jobId].images=[];
    // 组图片下沉副本（_fromGroup）不算用户 per-job 自定义：用户手动加图时先清掉，避免混发
    jc[jobId].images=jc[jobId].images.filter(function(im){return !im._fromGroup});
    var maxNew=10-(jc[jobId].images.length);
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    var done=0;
    var thatDiv=fileInput.closest('.univ-thumb-area');
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var u8=new Uint8Array(ab);
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          jc[jobId].images.push({src:thumb,fullSrc:lightboxSrc,name:f.name});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            fileInput.value='';
            Store.set('jobCustom',jc);
            if(thatDiv)thatDiv.innerHTML=window.renderJobThumbnailsHTML(jobId);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // ── B 页按组图片上传（hiddenFileInputB.dataset.ggi 标识目标组，只写该组 g.images）──
  E.hiddenFileInputB&&E.hiddenFileInputB.addEventListener('change',function(e){
    var gi=parseInt(E.hiddenFileInputB.dataset.ggi);
    var files=e.target.files;
    if(!files||!files.length||isNaN(gi))return;
    var groups=Store.get('groups')||[];
    var g=groups[gi];
    if(!g)return;
    if(!g.images)g.images=[];
    var maxNew=10-g.images.length;
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    if(!todo.length){e.target.value='';return}
    var done=0;
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          g.images.push({src:thumb,fullSrc:lightboxSrc,name:f.name,id:Date.now()+'_'+Math.random().toString(36).slice(2,6)});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            e.target.value='';
            Store.set('groups',groups);
            window.refreshGroupImages(gi);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  var pendingSingleSend=null;

  function findGroupForJob(jobId){
    var groups=Store.get('groups')||[];
    for(var i=0;i<groups.length;i++){
      var jobs=groups[i].jobs||[];
      for(var j=0;j<jobs.length;j++)if(String(jobs[j].id)===String(jobId))return groups[i];
    }
    return null;
  }

  function finalGreetingForJob(job){
    var custom=(Store.get('jobCustom')||{})[job.id]||{};
    var group=findGroupForJob(job.id);
    return String(custom.customGreeting||job.aiGreeting||(group&&group.greeting&&group.greeting.text)||'').trim();
  }

  function finalResumeNamesForJob(job){
    var custom=(Store.get('jobCustom')||{})[job.id]||{};
    var group=findGroupForJob(job.id);
    var images=(custom.images&&custom.images.length)?custom.images:
      (group&&group.images&&group.images.length?group.images:(Store.get('resumeImages')||[]));
    return (images||[]).map(function(img){return img.name||'图片简历'}).filter(Boolean);
  }

  function closeSingleSend(){
    pendingSingleSend=null;
    if(E.singleSendOverlay)E.singleSendOverlay.classList.add('hidden');
  }

  function renderSingleSend(job,token){
    pendingSingleSend={job:job,token:token};
    var ai=job.aiScreen||{};
    var risks=Array.isArray(ai.risks)&&ai.risks.length?ai.risks.join('；'):'无明确风险';
    var names=finalResumeNamesForJob(job);
    E.singleSendJob.textContent=(job.company||'')+'｜'+(job.name||'')+'｜'+(job.city||job.location||'城市未标注')+'｜'+(job.salary||'薪资未标注');
    E.singleSendAi.textContent='AI '+Number(ai.score||0)+' 分；'+(ai.reason||'未完成 AI 筛选')+'；风险：'+risks;
    E.singleSendGreeting.textContent=finalGreetingForJob(job)||'未配置招呼语，无法发送';
    E.singleSendResume.textContent=names.length?names.join('、'):'不发送图片简历';
    E.singleSendHistory.textContent=(job.historySkipReason||job.alreadyChatted)
      ?'已有沟通记录，请谨慎确认'
      :'未发现已有沟通记录';
    E.singleSendStatus.textContent='';
    E.singleSendConfirm.disabled=!finalGreetingForJob(job);
    if(E.singleSendRewriteInput){E.singleSendRewriteInput.value='';}
    if(E.singleSendRewriteBtn){E.singleSendRewriteBtn.disabled=false;E.singleSendRewriteBtn.textContent='AI 润色';}
    E.singleSendOverlay.classList.remove('hidden');
  }

  function prepareSingleSend(job){
    chrome.runtime.sendMessage({type:MSG.PREPARE_SINGLE_SEND,jobId:job.id},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        alert((resp&&resp.error)||chrome.runtime.lastError?.message||'无法准备岗位确认');
        return;
      }
      renderSingleSend(job,resp.token);
    });
  }

  // 招呼语 AI 润色：基于当前岗位最终招呼语 + 指令，重写后写回 jobCustom（确认发送时用润色结果）
  if(E.singleSendRewriteBtn){
    E.singleSendRewriteBtn.addEventListener('click',function(){
      if(!pendingSingleSend||!pendingSingleSend.job)return;
      var job=pendingSingleSend.job;
      var original=finalGreetingForJob(job);
      if(!original){E.singleSendStatus.textContent='当前岗位没有招呼语可润色';return;}
      var instruction=String(E.singleSendRewriteInput.value||'').trim()||'更专业、更真诚、语感更自然';
      E.singleSendRewriteBtn.disabled=true;E.singleSendRewriteBtn.textContent='润色中…';
      chrome.runtime.sendMessage({type:MSG.REWRITE_GREETING,greeting:original,instruction:instruction},function(resp){
        E.singleSendRewriteBtn.disabled=false;E.singleSendRewriteBtn.textContent='AI 润色';
        if(chrome.runtime.lastError||!resp||!resp.success){
          E.singleSendStatus.textContent='润色失败：'+(resp&&resp.error||(chrome.runtime.lastError&&chrome.runtime.lastError.message)||'');
          return;
        }
        var custom=Store.get('jobCustom')||{};
        custom[job.id]=Object.assign({},custom[job.id]||{},{customGreeting:resp.greeting});
        Store.set('jobCustom',custom);
        E.singleSendGreeting.textContent=resp.greeting;
        E.singleSendStatus.textContent='已用润色后的招呼语（覆盖原内容）';
      });
    });
  }
  if(E.singleSendRewriteInput){
    E.singleSendRewriteInput.addEventListener('keydown',function(e){
      if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(E.singleSendRewriteBtn)E.singleSendRewriteBtn.click();}
    });
  }
  if(E.singleSendClose)E.singleSendClose.addEventListener('click',closeSingleSend);
  if(E.singleSendSkip)E.singleSendSkip.addEventListener('click',function(){
    if(pendingSingleSend&&pendingSingleSend.job){
      pendingSingleSend.job.checked=false;
      pendingSingleSend.job.status='skipped';
      Store.set('jobs',Store.get('jobs')||[]);
      window.syncGroupsWithJobs&&window.syncGroupsWithJobs();
      window.updResCnt();
    }
    closeSingleSend();
  });
  if(E.singleSendConfirm)E.singleSendConfirm.addEventListener('click',function(){
    if(!pendingSingleSend)return;
    E.singleSendConfirm.disabled=true;
    E.singleSendStatus.textContent='正在启动当前岗位沟通...';
    window.syncGroupImagesToJobCustom&&window.syncGroupImagesToJobCustom();
    var payload=pendingSingleSend;
    var storagePatch={};
    storagePatch[STORAGE_KEYS.UI.JOB_CUSTOM]=Store.get('jobCustom')||{};
    chrome.storage.local.set(storagePatch,function(){
      if(chrome.runtime.lastError){
        E.singleSendConfirm.disabled=false;
        E.singleSendStatus.textContent='保存当前岗位配置失败';
        return;
      }
      chrome.runtime.sendMessage({
        type:MSG.CONFIRM_SINGLE_SEND,
        jobId:payload.job.id,
        token:payload.token,
        hrActiveFilter:Store.get('hrActiveFilter')||'不限'
      },function(resp){
        if(chrome.runtime.lastError||!resp||!resp.success){
          E.singleSendConfirm.disabled=false;
          E.singleSendStatus.textContent=(resp&&resp.error)||chrome.runtime.lastError?.message||'启动失败';
          return;
        }
        closeSingleSend();
        Store.set('sending',true);
        Store.set('progressDone',false);
        Store.set('reviewDismissed',false);
        E.progressSection.classList.remove('hidden');
        E.btnSend.textContent='停止发送';
        E.btnSend.classList.add('sending');
        E.btnSend.disabled=false;
        E.progressText.textContent='正在沟通当前岗位...';
        E.progressSub.textContent=payload.job.company+' · '+payload.job.name;
      });
    });
  });

  // ── Send button：勾选只形成复核队列，每次只确认一个岗位 ──
  E.btnSend.addEventListener('click',function(){
    var sending=Store.get('sending');
    if(sending){
      // 停止＝硬中止 + 统一终态：不在本地把 sending 置 false（否则后续 SEND_COMPLETE 的
      // `if(sending)` 守卫为假 → review 不渲染）。保持 sending=true，让 SW 的 stopSend→
      // finalizeTask→SEND_COMPLETE 回来时正常落 review（底部按钮变「重新投递」）。
      // 诊断包：用户点停止（popup 侧打点；即使 STOP_SEND 没送达 SW 也有记录）
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「停止发送」按钮')}catch(_){}
      E.btnSend.textContent='正在停止...';
      E.btnSend.disabled=true;
      E.progressText.textContent='正在停止...';
      E.progressSub.textContent='正在收尾，请稍候';
      try{chrome.runtime.sendMessage({type:MSG.STOP_SEND})}catch(ex){}
      return
    }
    var jobs=Store.get('jobs')||[];
    var firstJob=jobs.find(function(j){return j.checked});
    if(!firstJob){
      alert('当前没有已勾选的岗位，请重新勾选岗位后再投递');
      return
    }
    prepareSingleSend(firstJob);
  });
};
