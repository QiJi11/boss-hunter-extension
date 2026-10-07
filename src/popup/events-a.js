// ════════════════════════════════════════════════════════════
// 猎职 — A 页（筛选页）事件委托
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc/tog/togD (global)
// Depends on: TAG_DATA (from tag-data.js)
// Depends on: MSG (from constants.js)
// Depends on: render-a.js, getWorkAreas (from render-a.js)

window.initEventsA=function(){
  if(window._eventsAInitialized)return;
  window._eventsAInitialized=true;

  var FILTER_FIELDS = [
    { key: 'selectedCities', label: '目标城市' },
    { key: 'selectedPositions', label: '期望职位' },
    { key: 'customPositions', label: '自定义岗位' },
    { key: 'hrActiveFilter', label: 'HR 活跃度' },
    { key: 'selectedIndustries', label: '公司行业' },
    { key: 'workAreas', label: '工作区域' },
    { key: 'jobTypes', label: '工作性质' },
    { key: 'salaryRanges', label: '薪资待遇' },
    { key: 'experience', label: '工作经验' },
    { key: 'education', label: '学历要求' },
    { key: 'companySizes', label: '公司规模' },
    { key: 'fundingStages', label: '融资阶段' },
    { key: 'excludeKeywords', label: '排除词' },
    { key: 'skipHistoryEnabled', label: '历史跳过' }
  ];

  function setFilterSuggestionStatus(text, cls){
    if(!E.aiFilterStatus)return;
    E.aiFilterStatus.textContent=text||'';
    E.aiFilterStatus.className='ai-filter-status'+(cls?' '+cls:'');
  }

  /** 返回当前筛选快照，供 AI 建议和差异预览复用。 */
  function getCurrentFilterState(){
    return {
      selectedCities:[].concat(Store.get('selectedCities')||[]),
      selectedPositions:[].concat(Store.get('selectedPositions')||[]),
      customPositions:[].concat(Store.get('customPositions')||[]),
      hrActiveFilter:Store.get('hrActiveFilter')||'不限',
      selectedIndustries:[].concat(Store.get('selectedIndustries')||[]),
      workAreas:[].concat(Store.get('workAreas')||[]),
      jobTypes:[].concat(Store.get('jobTypes')||[]),
      salaryRanges:[].concat(Store.get('salaryRanges')||[]),
      experience:[].concat(Store.get('experience')||[]),
      education:[].concat(Store.get('education')||[]),
      companySizes:[].concat(Store.get('companySizes')||[]),
      fundingStages:[].concat(Store.get('fundingStages')||[]),
      excludeKeywords:[].concat(Store.get('excludeKeywords')||[]),
      skipHistoryEnabled:Store.get('skipHistoryEnabled')!==false,
      skipHistoryScope:'hr',
    };
  }

  function cityNameMap(){
    var map={'000000':'全国'};
    (TAG_DATA.cities||[]).forEach(function(city){ map[city.code]=city.name; });
    return map;
  }

  function getAllowedFilterValues(){
    return {
      citiesByName:(TAG_DATA.cities||[]).concat([{name:'全国',code:'000000'}]).reduce(function(acc, city){ acc[city.name]=city.code; return acc; }, {}),
      positionsByName:allPos().reduce(function(acc, item){ acc[item.name]=true; return acc; }, {}),
      industriesByName:allInd().reduce(function(acc, item){ acc[item.name]=true; return acc; }, {}),
      hrActive:['不限','只投在线','3日内活跃','本周内活跃','本月内活跃'],
      workAreas:getWorkAreas(),
      jobTypes:TAG_DATA.jobTypes||['不限','全职','兼职'],
      salaryRanges:TAG_DATA.salaryRanges||['不限','3K以下','3-5K','5-10K','10-20K','20-50K','50K以上'],
      experience:TAG_DATA.experience||['不限','在校生(实习)','应届生(校招)','经验不限','1年以内','1-3年','3-5年','5-10年','10年以上'],
      education:TAG_DATA.education||['不限','初中及以下','中专/中技','高中','大专','本科','硕士','博士'],
      companySizes:TAG_DATA.companySizes||['不限','0-20人','20-99人','100-499人','500-999人','1000-9999人','10000人以上'],
      fundingStages:TAG_DATA.fundingStages||['不限','未融资','天使轮','A轮','B轮','C轮','D轮及以上','已上市','不需要融资']
    };
  }

  function uniqueStrings(list){
    var out=[], seen={};
    (Array.isArray(list)?list:[]).forEach(function(item){
      var text=String(item||'').trim();
      if(!text||seen[text])return;
      seen[text]=true;
      out.push(text);
    });
    return out;
  }

  function formatPreviewValue(key, value){
    if(Array.isArray(value)){
      if(key==='selectedCities'){
        var names=uniqueStrings(value).map(function(code){ return cityNameMap()[code]||code; });
        return names.length?names.join('、'):'不限';
      }
      return value.length?value.join('、'):'不限';
    }
    return value?String(value):'不限';
  }

  /** 归一化 AI 建议，过滤非法值并产出差异预览。 */
  function normalizeFilterSuggestion(raw){
    var base=getCurrentFilterState();
    var allowed=getAllowedFilterValues();
    var ignored=uniqueStrings((raw&&raw.ignored)||[]);
    var next=JSON.parse(JSON.stringify(base));
    var changes=(raw&&raw.changes&&typeof raw.changes==='object')?raw.changes:{};

    function applyArrayField(key, values, allowMap, options){
      if(!(key in changes))return;
      var opts=options||{};
      if(!Array.isArray(values)){ignored.push(key+' 格式错误');return;}
      if(values.length===0){next[key]=opts.emptyValue||['不限'];return;}
      var valid=[], unknown=[];
      uniqueStrings(values).forEach(function(item){
        if(allowMap[item])valid.push(opts.transform?opts.transform(item):item);
        else unknown.push(item);
      });
      if(opts.collectUnknownAsCustom){
        next.customPositions=uniqueStrings((next.customPositions||[]).concat(unknown));
      }else{
        ignored=ignored.concat(unknown);
      }
      next[key]=valid.length?valid:(opts.emptyValue||['不限']);
    }

    if('selectedCities' in changes){
      var rawCities=changes.selectedCities;
      if(!Array.isArray(rawCities)){ignored.push('selectedCities 格式错误');}
      else if(!rawCities.length){next.selectedCities=[];}
      else{
        var cityCodes=[], cityUnknown=[];
        uniqueStrings(rawCities).forEach(function(name){
          var code=allowed.citiesByName[name];
          if(code)cityCodes.push(code); else cityUnknown.push(name);
        });
        ignored=ignored.concat(cityUnknown);
        next.selectedCities=cityCodes;
      }
    }

    if('selectedPositions' in changes){
      applyArrayField('selectedPositions', changes.selectedPositions, allowed.positionsByName, { emptyValue: [], collectUnknownAsCustom: true });
    }
    if('customPositions' in changes){
      if(!Array.isArray(changes.customPositions))ignored.push('customPositions 格式错误');
      else next.customPositions=uniqueStrings(changes.customPositions);
    }
    if('hrActiveFilter' in changes){
      if(changes.hrActiveFilter===''){next.hrActiveFilter='不限';}
      else if(allowed.hrActive.indexOf(changes.hrActiveFilter)>=0){next.hrActiveFilter=changes.hrActiveFilter;}
      else ignored.push(String(changes.hrActiveFilter));
    }
    applyArrayField('selectedIndustries', changes.selectedIndustries, allowed.industriesByName, { emptyValue: [] });
    applyArrayField('workAreas', changes.workAreas, (allowed.workAreas||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('jobTypes', changes.jobTypes, (allowed.jobTypes||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('salaryRanges', changes.salaryRanges, (allowed.salaryRanges||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('experience', changes.experience, (allowed.experience||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('education', changes.education, (allowed.education||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('companySizes', changes.companySizes, (allowed.companySizes||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    applyArrayField('fundingStages', changes.fundingStages, (allowed.fundingStages||[]).reduce(function(acc, item){ acc[item]=true; return acc; }, {}), { emptyValue: ['不限'] });
    if('excludeKeywords' in changes){
      if(!Array.isArray(changes.excludeKeywords))ignored.push('excludeKeywords 格式错误');
      else next.excludeKeywords=uniqueStrings(changes.excludeKeywords);
    }
    if('skipHistoryEnabled' in changes){
      next.skipHistoryEnabled=changes.skipHistoryEnabled!==false;
      next.skipHistoryScope='hr';
    }

    var rows=FILTER_FIELDS.map(function(field){
      var before=formatPreviewValue(field.key, base[field.key]);
      var after=formatPreviewValue(field.key, next[field.key]);
      if(before===after)return null;
      return { label: field.label, before: before, after: after };
    }).filter(Boolean);

    return {
      summary:String(raw&&raw.summary||'').trim(),
      nextState:next,
      ignored:uniqueStrings(ignored),
      diffRows:rows
    };
  }

  function renderStoredSuggestion(){
    var draft=Store.get('filterSuggestionDraft');
    if(E.aiFilterApplyBtn)E.aiFilterApplyBtn.classList.toggle('hidden',!draft);
    if(E.aiFilterDiscardBtn)E.aiFilterDiscardBtn.classList.toggle('hidden',!draft);
    if(window.renderFilterSuggestionPreview)window.renderFilterSuggestionPreview(draft);
  }

  /** 应用 AI 建议到现有 Store，并刷新当前设置页所有已选状态。 */
  function applyFilterState(nextState){
    markConfigEdit();
    Store.set('selectedCities', nextState.selectedCities||[]);
    Store.set('selectedPositions', nextState.selectedPositions||[]);
    Store.set('customPositions', nextState.customPositions||[]);
    Store.set('hrActiveFilter', nextState.hrActiveFilter||'不限');
    Store.set('selectedIndustries', nextState.selectedIndustries||[]);
    Store.set('workAreas', nextState.workAreas&&nextState.workAreas.length?nextState.workAreas:['不限']);
    Store.set('jobTypes', nextState.jobTypes&&nextState.jobTypes.length?nextState.jobTypes:['不限']);
    Store.set('salaryRanges', nextState.salaryRanges&&nextState.salaryRanges.length?nextState.salaryRanges:['不限']);
    Store.set('experience', nextState.experience&&nextState.experience.length?nextState.experience:['不限']);
    Store.set('education', nextState.education&&nextState.education.length?nextState.education:['不限']);
    Store.set('companySizes', nextState.companySizes&&nextState.companySizes.length?nextState.companySizes:['不限']);
    Store.set('fundingStages', nextState.fundingStages&&nextState.fundingStages.length?nextState.fundingStages:['不限']);
    Store.set('excludeKeywords', uniqueStrings(nextState.excludeKeywords||[]));
    Store.set('skipHistoryEnabled', nextState.skipHistoryEnabled!==false);
    Store.set('skipHistoryScope','hr');
    window.renderCityChips(E.cityInput.value||'');
    window.renderChipSecs();
    window.renderSettings();
    window.renderSendGreetingToggle&&window.renderSendGreetingToggle();
    persistFilterState();
  }

  function markConfigEdit(){
    if(window.dismissReviewForConfigEdit)window.dismissReviewForConfigEdit();
  }

  // ── City chips ──
  E.cityChipContainer.addEventListener('click',function(e){
    var chip=e.target.closest('.city-chip');if(!chip)return;
    markConfigEdit();
    var code=chip.dataset.code;
    var selected=Store.get('selectedCities')||[];
    var i=selected.indexOf(code);
    if(i>=0)selected.splice(i,1);else selected.push(code);
    Store.set('selectedCities',selected);
    window.renderCityChips(E.cityInput.value);
    window.renderChipSecs();
    try{persistFilterState()}catch(ex){}
  });
  E.cityInput.addEventListener('input',function(){markConfigEdit();window.renderCityChips(E.cityInput.value)});

  // ── City selected tags（删除已选城市，复刻「期望职位」已选 tag 交互）──
  E.citySelectedArea.addEventListener('click',function(e){
    var tag=e.target.closest('.selected-tag[data-code]');
    if(!tag)return;
    markConfigEdit();
    var selected=Store.get('selectedCities')||[];
    var i=selected.indexOf(tag.dataset.code);
    if(i>=0)selected.splice(i,1);
    Store.set('selectedCities',selected);
    window.renderCityChips(E.cityInput.value);
    window.renderChipSecs();
    try{persistFilterState()}catch(ex){}
  });

  // ── Thumbnail helper ──
  function createThumbnail(file, maxW, maxH){
    return new Promise(function(resolve){
      var reader = new FileReader();
      reader.onload = function(e){
        var img = new Image();
        img.onload = function(){
          var cv = document.createElement('canvas');
          var w = img.width, h = img.height;
          if(w > maxW){h = h * maxW / w; w = maxW}
          if(h > maxH){w = w * maxH / h; h = maxH}
          cv.width = Math.round(w);
          cv.height = Math.round(h);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.7));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  window.createThumbnail = createThumbnail;

  // ── Resume upload (先构建完整数组，最后一次性写入 storage 避免并行覆盖) ──
  E.hiddenFileInput.addEventListener('change',function(e){
    var files=e.target.files;
    if(!files||!files.length)return;
    var images=Store.get('resumeImages')||[];
    var maxNew=10-images.length;
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    var pendingImages=[];
    var pendingStore=[];
    var done=0;
    function chkDoneAll(){
      done++;
      if(done===todo.length){
        e.target.value='';
        // 所有缩略图生成完毕，一次性更新 Store 和 chrome.storage
        var newImages=Store.get('resumeImages')||[];
        pendingImages.forEach(function(pi){newImages.push(pi)});
        Store.set('resumeImages',newImages);
        window.refreshBImages();
        // 原子写入 storage（通过 serailized queue 避免竞态）
        atomicUpdateResumeImages(function(arr){
          pendingStore.forEach(function(ps){arr.push(ps)});
          return arr;
        });
      }
    }
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var u8=new Uint8Array(ab);
        var data=Array.prototype.slice.call(u8);
        var id=Date.now()+'_'+Math.random().toString(36).slice(2,6);
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
          // Lightbox-size version (much larger for detail viewing)
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          pendingImages.push({src:thumb,fullSrc:lightboxSrc,name:f.name,id:id});
          pendingStore.push({name:f.name,type:f.type,data:data,id:id,thumb:thumb,fullSrc:lightboxSrc});
          URL.revokeObjectURL(img.src);
          chkDoneAll();
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // A page resume thumb click delegation
  E.resumeThumbArea.addEventListener('click',function(e){
    var imgEl=e.target.closest('.univ-thumb img');
    if(imgEl){
      var gimg=imgEl.dataset.gimg;
      var images=Store.get('resumeImages')||[];
      var imgData=images[parseInt(gimg)];
      var src=(imgData&&imgData.fullSrc)?imgData.fullSrc:imgEl.src;
      showImageLightbox(src);return
    }
    var add=e.target.closest('[data-gact="addImg"]');
    if(add){E.hiddenFileInput.click();return}
    var rem=e.target.closest('.thumb-remove');
    if(rem){
      var idx=parseInt(rem.dataset.gimg);
      if(!isNaN(idx)&&idx>=0){
        var images=Store.get('resumeImages')||[];
        if(idx<images.length){
          var rid=images[idx].id;
          images.splice(idx,1);
          Store.set('resumeImages',images);
          window.refreshBImages();
          atomicUpdateResumeImages(function(arr){
            return arr.filter(function(it){return it.id!==rid});
          });
        }
      }
    }
  });

  // ── Position search ──
  E.posBrowseArea.addEventListener('click',function(e){
    var addBtn=e.target.closest('[data-addcustom]');
    if(addBtn){
      markConfigEdit();
      var w=(addBtn.dataset.addcustom||'').trim();
      if(w){
        var cp=Store.get('customPositions')||[];
        var sp=Store.get('selectedPositions')||[];
        if(cp.indexOf(w)<0&&sp.indexOf(w)<0)cp.push(w);
        Store.set('customPositions',cp);
        E.posSearch.value='';Store.set('posSearchQuery','');E.posSearchClear.style.display='none';
        window.renderPosBrowse();persistFilterState();
      }
      return
    }
    var ctag=e.target.closest('.selected-tag[data-custompos]');
    if(ctag){
      markConfigEdit();
      var cp2=Store.get('customPositions')||[];
      var ci=cp2.indexOf(ctag.dataset.custompos);
      if(ci>=0)cp2.splice(ci,1);
      Store.set('customPositions',cp2);
      window.renderPosBrowse();persistFilterState();
      return
    }
    var chip=e.target.closest('.chip[data-pos]');
    if(chip){
      markConfigEdit();
      var sel=Store.get('selectedPositions')||[];
      togD(sel,chip.dataset.pos,false);
      Store.set('selectedPositions',sel);
      window.renderPosBrowse();
      persistFilterState();
      return
    }
    var tag=e.target.closest('.selected-tag[data-pos]');
    if(tag){
      markConfigEdit();
      var sel=Store.get('selectedPositions')||[];
      var i=sel.indexOf(tag.dataset.pos);
      if(i>=0)sel.splice(i,1);
      Store.set('selectedPositions',sel);
      window.renderPosBrowse();
      persistFilterState();
      return
    }
  });
  // ── HR 活跃度单选 ──
  var _hrActiveCont=document.getElementById('hrActiveChips');
  if(_hrActiveCont){
    _hrActiveCont.addEventListener('click',function(e){
      var c=e.target.closest('.chip[data-hract]');if(!c)return;
      markConfigEdit();
      Store.set('hrActiveFilter',c.dataset.hract);
      if(window.renderHrActiveChips)window.renderHrActiveChips();
      persistFilterState();
    });
  }
  E.posSearch.addEventListener('input',function(){
    markConfigEdit();
    Store.set('posSearchQuery',E.posSearch.value);
    var q=Store.get('posSearchQuery');
    E.posSearchClear.style.display=q?'block':'none';
    window.renderPosBrowse()
  });
  E.posSearchClear.addEventListener('click',function(){
    markConfigEdit();
    E.posSearch.value='';
    Store.set('posSearchQuery','');
    E.posSearchClear.style.display='none';
    window.renderPosBrowse();
    E.posSearch.focus()
  });
  if(E.sendGreetingToggle){
    E.sendGreetingToggle.addEventListener('change',function(){
      markConfigEdit();
      Store.set('sendGreeting',!!E.sendGreetingToggle.checked);
      persistFilterState();
    });
  }
  if(E.skipHistoryToggle){
    E.skipHistoryToggle.addEventListener('change',function(){
      markConfigEdit();
      Store.set('skipHistoryEnabled',!!E.skipHistoryToggle.checked);
      Store.set('skipHistoryScope','hr');
      persistFilterState();
    });
  }
  function addExcludeKeyword(){
    var input=E.excludeKeywordInput;
    var value=input?input.value.trim():'';
    if(!value)return;
    markConfigEdit();
    var list=uniqueStrings((Store.get('excludeKeywords')||[]).concat([value]));
    Store.set('excludeKeywords',list);
    if(input)input.value='';
    window.renderExcludeKeywords&&window.renderExcludeKeywords();
    persistFilterState();
  }
  if(E.addExcludeKeywordBtn)E.addExcludeKeywordBtn.addEventListener('click',addExcludeKeyword);
  if(E.excludeKeywordInput)E.excludeKeywordInput.addEventListener('keydown',function(e){
    if(e.key==='Enter'){
      e.preventDefault();
      addExcludeKeyword();
    }
  });
  if(E.excludeKeywordTags)E.excludeKeywordTags.addEventListener('click',function(e){
    var tag=e.target.closest('.selected-tag[data-exclude-keyword]');
    if(!tag)return;
    markConfigEdit();
    var list=Store.get('excludeKeywords')||[];
    var idx=list.indexOf(tag.dataset.excludeKeyword);
    if(idx>=0)list.splice(idx,1);
    Store.set('excludeKeywords',uniqueStrings(list));
    window.renderExcludeKeywords&&window.renderExcludeKeywords();
    persistFilterState();
  });

  // ── Industry search ──
  E.indArea.addEventListener('click',function(e){
    var chip=e.target.closest('.chip[data-ind]');
    if(chip){
      markConfigEdit();
      var sel=Store.get('selectedIndustries')||[];
      togD(sel,chip.dataset.ind,false);
      Store.set('selectedIndustries',sel);
      window.renderInd();
      persistFilterState();
      return
    }
    var tag=e.target.closest('.selected-tag[data-ind]');
    if(tag){
      markConfigEdit();
      var sel=Store.get('selectedIndustries')||[];
      var i=sel.indexOf(tag.dataset.ind);
      if(i>=0)sel.splice(i,1);
      Store.set('selectedIndustries',sel);
      window.renderInd();
      persistFilterState();
      return
    }
    var hdr=e.target.closest('[data-toggle="ind"]');
    if(hdr){var g=hdr.closest('.industry-group');if(g)g.classList.toggle('collapsed')}
  });
  E.indSearch.addEventListener('input',function(){
    markConfigEdit();
    Store.set('indSearchQuery',E.indSearch.value);
    var q=Store.get('indSearchQuery');
    E.indSearchClear.style.display=q?'block':'none';
    window.renderInd()
  });
  E.indSearchClear.addEventListener('click',function(){
    markConfigEdit();
    E.indSearch.value='';
    Store.set('indSearchQuery','');
    E.indSearchClear.style.display='none';
    window.renderInd();
    E.indSearch.focus()
  });
  E.expandIndustries.addEventListener('click',function(){
    var show=Store.get('showAllIndustries');
    Store.set('showAllIndustries',!show);
    window.renderInd()
  });

  // ── Chip sections ──
  var chipSecs=[
    {e:E.workAreaChips,k:'workAreas'},
    {e:E.jobTypeChips,k:'jobTypes'},
    {e:E.salaryChips,k:'salaryRanges'},
    {e:E.expChips,k:'experience'},
    {e:E.eduChips,k:'education'},
    {e:E.sizeChips,k:'companySizes'},
    {e:E.stageChips,k:'fundingStages'}
  ];
  var chipData={
    workAreas:null, // lazy from getWorkAreas
    jobTypes:['不限','全职','兼职'],
    salaryRanges:['不限','3K以下','3-5K','5-10K','10-20K','20-50K','50K以上'],
    experience:['不限','在校生(实习)','应届生(校招)','经验不限','1年以内','1-3年','3-5年','5-10年','10年以上'],
    education:['不限','初中及以下','中专/中技','高中','大专','本科','硕士','博士'],
    companySizes:['不限','0-20人','20-99人','100-499人','500-999人','1000-9999人','10000人以上'],
    fundingStages:['不限','未融资','天使轮','A轮','B轮','C轮','D轮及以上','已上市','不需要融资']
  };
  chipSecs.forEach(function(sec){
    sec.e.addEventListener('click',function(e){
      var c=e.target.closest('.chip');if(!c||!c.dataset.val)return;
      markConfigEdit();
      var v=c.dataset.val;
      var arr=Store.get(sec.k)||[];
      var da=sec.k==='workAreas'?getWorkAreas():chipData[sec.k];
      var hd=da&&da[0]==='不限';
      togD(arr,v,hd);
      Store.set(sec.k,arr);
      var items=sec.k==='workAreas'?getWorkAreas():chipData[sec.k];
      window.renderChips(sec.e,items,Store.get(sec.k)||[]);
      persistFilterState();
    })
  });

  // ── Reset & Collect buttons ──
  E.btnReset.addEventListener('click',function(){
    markConfigEdit();
    Store.set('selectedCities',[]);
    Store.set('selectedPositions',[]);
    Store.set('customPositions',[]);
    Store.set('hrActiveFilter','不限');
    Store.set('selectedIndustries',[]);
    Store.set('workAreas',['不限']);
    Store.set('jobTypes',['不限']);
    Store.set('salaryRanges',['不限']);
    Store.set('experience',['不限']);
    Store.set('education',['不限']);
    Store.set('companySizes',['不限']);
    Store.set('fundingStages',['不限']);
    Store.set('excludeKeywords',typeof DEFAULT_EXCLUDE_KEYWORDS!=='undefined'?DEFAULT_EXCLUDE_KEYWORDS.slice():[]);
    Store.set('skipHistoryEnabled',true);
    Store.set('skipHistoryScope','hr');
    Store.set('posSearchQuery','');
    Store.set('indSearchQuery','');
    E.posSearch.value='';
    E.indSearch.value='';
    E.posSearchClear.style.display='none';
    E.indSearchClear.style.display='none';
    Store.set('resumeImages',[]);
    window.renderResumeImages();
    Store.set('cityExpanded',false);
    window.renderCityChips('');
    chrome.storage.local.remove('resumeImages',function(){});
    window.renderSettings();
    persistFilterState();
    // 清除发送相关状态（保留 sw:sendResults：投递结果是诊断证据，重置不删）
    chrome.storage.local.remove('sw:sentJobIds');
    chrome.runtime.sendMessage({type:'CLEAR_SENT_JOB_IDS'});
  });
  E.btnCollect.addEventListener('click',function(){
    var cities=Store.get('selectedCities')||[];
    var positions=Store.get('selectedPositions')||[];
    var customPos=Store.get('customPositions')||[];
    if(!cities.length||(!positions.length&&!customPos.length)){
      alert('请至少选择目标城市和期望职位');
      return;
    }
    window.toResults();
  });
  E.btnBack.addEventListener('click',window.toSettings);

  if(E.aiFilterGenerateBtn){
    E.aiFilterGenerateBtn.addEventListener('click',function(){
      var prompt=(E.aiFilterPrompt&&E.aiFilterPrompt.value||'').trim();
      if(!prompt){setFilterSuggestionStatus('请先输入你想怎么改筛选条件','error');return;}
      E.aiFilterGenerateBtn.disabled=true;
      setFilterSuggestionStatus('正在生成建议...','');
      try{
        chrome.runtime.sendMessage({
          type:MSG.GENERATE_FILTER_SUGGESTION,
          prompt:prompt,
          filterState:getCurrentFilterState()
        },function(resp){
          E.aiFilterGenerateBtn.disabled=false;
          if(chrome.runtime.lastError||!resp||!resp.success){
            setFilterSuggestionStatus('生成失败：'+((resp&&resp.error)||chrome.runtime.lastError?.message||'未知错误'),'error');
            return;
          }
          var normalized=normalizeFilterSuggestion(resp.result||{});
          Store.set('filterSuggestionDraft',normalized);
          renderStoredSuggestion();
          setFilterSuggestionStatus('建议已生成，请确认差异后再应用','success');
        });
      }catch(ex){
        E.aiFilterGenerateBtn.disabled=false;
        setFilterSuggestionStatus('生成失败：'+ex.message,'error');
      }
    });
  }

  if(E.aiFilterApplyBtn){
    E.aiFilterApplyBtn.addEventListener('click',function(){
      var draft=Store.get('filterSuggestionDraft');
      if(!draft||!draft.nextState){setFilterSuggestionStatus('当前没有可应用的建议','error');return;}
      applyFilterState(draft.nextState);
      Store.set('filterSuggestionDraft',null);
      renderStoredSuggestion();
      setFilterSuggestionStatus('筛选条件已应用，未自动开始采集','success');
    });
  }

  if(E.aiFilterDiscardBtn){
    E.aiFilterDiscardBtn.addEventListener('click',function(){
      Store.set('filterSuggestionDraft',null);
      renderStoredSuggestion();
      setFilterSuggestionStatus('已放弃本次建议','');
    });
  }
};

// ── Collect params builder ──
window.buildCollectParams=function(){
  var state=Store.get();
  var urlParams={city:(state.city||{}).code||''};
  var selectedCities=state.selectedCities||[];
  if(selectedCities.length>0)urlParams.city=selectedCities[0];
  var _allPos=(state.selectedPositions||[]).concat(state.customPositions||[]);
  if(state.jobTypes&&state.jobTypes.length>0){var jtMap={'全职':'1','兼职':'2'};var mapped=state.jobTypes.map(function(t){return jtMap[t]}).filter(Boolean);if(mapped.length)urlParams.jobType=mapped.join(',')}
  if(state.experience&&state.experience.length>0){var expMap={'在校生(实习)':'108','应届生(校招)':'102','经验不限':'101','1年以内':'103','1-3年':'104','3-5年':'105','5-10年':'106','10年以上':'107'};var mapped=state.experience.map(function(e){return expMap[e]}).filter(Boolean);if(mapped.length)urlParams.experience=mapped.join(',')}
  if(state.education&&state.education.length>0){var degMap={'初中及以下':'209','中专/中技':'208','高中':'206','大专':'202','本科':'203','硕士':'204','博士':'205'};var mapped=state.education.map(function(d){return degMap[d]}).filter(Boolean);if(mapped.length)urlParams.degree=mapped.join(',')}
  if(state.salaryRanges&&state.salaryRanges.length>0){var salaryMap={'3K以下':'1','3-5K':'2','5-10K':'3','10-20K':'4','20-50K':'5','50K以上':'6'};var mapped=state.salaryRanges.map(function(s){return salaryMap[s]}).filter(Boolean);if(mapped.length)urlParams.salary=mapped.join(',')}
  if(state.selectedIndustries&&state.selectedIndustries.length>0)urlParams.industry=state.selectedIndustries.join(',');
  if(state.companySizes&&state.companySizes.length>0){var scaleMap={'0-20人':'301','20-99人':'302','100-499人':'303','500-999人':'304','1000-9999人':'305','10000人以上':'306'};var mapped=state.companySizes.map(function(s){return scaleMap[s]}).filter(Boolean);if(mapped.length)urlParams.scale=mapped.join(',')}
  if(state.fundingStages&&state.fundingStages.length>0){var stageMap={'未融资':'801','天使轮':'802','A轮':'803','B轮':'804','C轮':'805','D轮及以上':'806','已上市':'807','不需要融资':'808'};var mapped=state.fundingStages.map(function(s){return stageMap[s]}).filter(Boolean);if(mapped.length)urlParams.stage=mapped.join(',')}
  if(state.workAreas&&state.workAreas.length>0){
    // BOSS 真实参数 = multiBusinessDistrict=<6位districtCode>,...，区中文名写 district= 无效
    var _cityCode=(state.selectedCities&&state.selectedCities[0])||(state.city&&state.city.code)||'';
    var _dMap=(typeof TAG_DATA!=='undefined'&&TAG_DATA.districtCodes)?TAG_DATA.districtCodes[_cityCode]:null;
    if(_dMap){
      var _codes=state.workAreas.map(function(n){return _dMap[n];}).filter(function(c){return c!=null;});
      if(_codes.length)urlParams.multiBusinessDistrict=_codes.join(',');
    }
  }
  var tags=[];
  if(_allPos.length>0)tags.push.apply(tags,_allPos);
  var selectedFilters={};
  if(state.workAreas&&state.workAreas.length>0)selectedFilters.workAreas=[].concat(state.workAreas);
  if(state.jobTypes&&state.jobTypes.length>0)selectedFilters.jobTypes=[].concat(state.jobTypes);
  if(state.salaryRanges&&state.salaryRanges.length>0)selectedFilters.salaryRanges=[].concat(state.salaryRanges);
  if(state.experience&&state.experience.length>0)selectedFilters.experience=[].concat(state.experience);
  if(state.education&&state.education.length>0)selectedFilters.education=[].concat(state.education);
  if(state.selectedIndustries&&state.selectedIndustries.length>0)selectedFilters.industries=[].concat(state.selectedIndustries);
  if(state.companySizes&&state.companySizes.length>0)selectedFilters.companySizes=[].concat(state.companySizes);
  if(state.fundingStages&&state.fundingStages.length>0)selectedFilters.fundingStages=[].concat(state.fundingStages);
  return {
    urlParams:urlParams,
    tags:tags,
    filters:selectedFilters,
    selectedPositions:[].concat(state.selectedPositions||[]),
    customPositions:[].concat(state.customPositions||[]),
    selectedCities:selectedCities,
    excludeKeywords:uniqueStrings(state.excludeKeywords||[]),
    skipHistoryEnabled:state.skipHistoryEnabled!==false,
    skipHistoryScope:'hr'
  };
};

// ── A 页筛选条件持久化 ──
var _filterPersistTimer = null;
function persistFilterState() {
  clearTimeout(_filterPersistTimer);
  _filterPersistTimer = setTimeout(function () {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    if (typeof STORAGE_KEYS === 'undefined') return;
    try {
      var s = Store.get();
      chrome.storage.local.set({
        [STORAGE_KEYS.UI.FILTER_STATE]: {
          selectedCities: s.selectedCities,
          selectedPositions: s.selectedPositions,
          customPositions: s.customPositions,
          sendGreeting: s.sendGreeting !== false,
          hrActiveFilter: s.hrActiveFilter,
          selectedIndustries: s.selectedIndustries,
          workAreas: s.workAreas,
          jobTypes: s.jobTypes,
          salaryRanges: s.salaryRanges,
          experience: s.experience,
          education: s.education,
          companySizes: s.companySizes,
          fundingStages: s.fundingStages,
          excludeKeywords: uniqueStrings(s.excludeKeywords || []),
          skipHistoryEnabled: s.skipHistoryEnabled !== false,
          skipHistoryScope: 'hr',
        }
      });
    } catch (e) {}
  }, 300);
}

// ── Image lightbox ──
function showImageLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'img-lightbox-overlay';
  overlay.innerHTML = '<img src="' + src + '" class="img-lightbox">';
  overlay.addEventListener('click', function() {
    overlay.remove();
    document.removeEventListener('keydown', esc);
  });
  function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  }
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
}
