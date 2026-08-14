(function(root) {
  'use strict';

  function uniqueIdentityStrings(values) {
    var seen = {};
    var unique = [];
    (Array.isArray(values) ? values : []).forEach(function(value) {
      var normalized = String(value || '').trim();
      var key = normalized.toLowerCase();
      if (!normalized || seen[key]) return;
      seen[key] = true;
      unique.push(normalized);
    });
    return unique;
  }

  function normalizeIdentityCandidate(value) {
    return String(value || '')
      .replace(/^[\s，,。；;：:|｜·-]+|[\s，,。；;：:|｜·-]+$/g, '')
      .replace(/^(?:曾经?|我|本人|主要)\s*/, '')
      .replace(/\s*(?:的)?$/, '')
      .trim();
  }

  function isLikelyOrganizationName(value) {
    var candidate = normalizeIdentityCandidate(value);
    if (candidate.length < 2 || candidate.length > 30 || /^\d+$/.test(candidate)) return false;
    var genericLabels = [
      'ai', 'agent', 'llm', 'rag', 'api', '大模型', '知识库', '智能问答',
      '客服', '后端', '前端', '全栈', '数据', '推荐', '搜索', '聊天', '自动化',
      '个人', '团队', '企业', '系统', '平台', '项目', '毕业设计', '课程设计',
      '数字化', '供应链', '软件工程', '人工智能',
    ];
    return genericLabels.indexOf(candidate.toLowerCase()) < 0;
  }

  function collectIdentityMatches(text, pattern, groupIndex, output) {
    var match;
    while ((match = pattern.exec(text))) {
      var candidate = normalizeIdentityCandidate(match[groupIndex]);
      if (isLikelyOrganizationName(candidate)) output.push(candidate);
    }
  }

  function collectStandaloneEmployerMatches(text, pattern, output) {
    var match;
    while ((match = pattern.exec(text))) {
      var candidate = normalizeIdentityCandidate(match[1]);
      var isJobTitle = /(?:工程师|开发|经理|实习生|顾问|设计师|分析师|负责人|专员|助理)$/.test(candidate);
      if (!isJobTitle && isLikelyOrganizationName(candidate)) output.push(candidate);
    }
  }

  function extractGreetingOrganizationNames(text) {
    var organizations = [];
    var suffixPattern = /(?:^|[\s|｜，,。；;：:\n])([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,30}?(?:有限责任公司|股份有限公司|有限公司|公司|集团|银行|研究院|实验室|事务所|工作室|大学|学院|学校))(?=$|[\s|｜，,。；;：:\n])/g;
    var employmentPattern = /(?:在|于|来自|加入|就职于|任职于)\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,24}?)(?=\s*(?:负责|从事|担任|参与|完成|开展|实习|工作|做过))/g;
    var standaloneEmploymentPattern = /(?:^|\n)\s*(?:工作经历|实习经历)\s*[：:]?\s*\n\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,30})(?=\s*(?:\n|[|｜]|(?:19|20)\d{2}))/g;
    var clientPattern = /(?:服务过|对接过|负责过|合作过|面向|支持过?|客户[：:]?|甲方[：:]?|合作方[：:]?)\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,20}?)(?=\s*(?:客户|[，,。；;\n]|$))/g;
    var serviceRelationshipPattern = /(?:(?:服务|支持|对接|合作)(?!过))\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,20}?)(?=\s*(?:供应链|业务|团队|平台|系统|客户))/g;
    var deliveryPattern = /(?:为|向|给)\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,20}?)(?=\s*(?:交付|提供|搭建|实施|开发|服务))/g;
    var standaloneProjectPattern = /(?:^|\n)\s*项目经历\s*[：:]?\s*\n\s*([\u4e00-\u9fffA-Za-z0-9·&（）()_-]{2,16}?)(?=\s*(?:数字化|供应链|制造|零售|电商|金融|医疗|客服|营销|业务)?项目(?:\s|$|[|｜·-]))/g;
    var brandedProjectPattern = /(?:参与过?|负责过?|做过|完成|开展)\s*([\u4e00-\u9fffA-Za-z0-9·&_-]{2,16}?)(?=\s*(?:数字化|供应链|制造|零售|电商|金融|医疗|客服|营销|业务)?项目)/g;
    collectIdentityMatches(text, suffixPattern, 1, organizations);
    collectIdentityMatches(text, employmentPattern, 1, organizations);
    collectStandaloneEmployerMatches(text, standaloneEmploymentPattern, organizations);
    collectIdentityMatches(text, clientPattern, 1, organizations);
    collectIdentityMatches(text, serviceRelationshipPattern, 1, organizations);
    collectIdentityMatches(text, deliveryPattern, 1, organizations);
    collectIdentityMatches(text, standaloneProjectPattern, 1, organizations);
    collectIdentityMatches(text, brandedProjectPattern, 1, organizations);
    return uniqueIdentityStrings(organizations);
  }

  // 外发招呼语默认不得带求职者/招聘者姓名、客户名、公司名或署名。
  // 所有来源（AI、历史缓存、customGreeting）在发送前都必须走该函数。
  function sanitizeGeneratedGreeting(text, blockedNames) {
    var greeting = String(text || '').replace(/\s+/g, ' ').trim();
    if (!greeting) return '';
    var allowedSelfDescriptions = ['应届生', '求职者', '开发者', '工程师', '毕业生', '程序员'];
    var allowedRolePrefixes = [
      '产品', '项目', '招聘', '人事', '技术', '部门', '研发',
      '业务', '客户', '销售', '市场', '运营', '设计', '算法', '工程', '用人', '总',
    ];
    var allowedClauseSubjects = allowedSelfDescriptions.concat(['我', '本人', '个人', '团队']);
    function isAllowedRoleLabel(label) {
      var match = String(label || '').match(/^([\u4e00-\u9fff]{1,2})(总|经理|老师|先生|女士)$/);
      return !!match && allowedRolePrefixes.indexOf(match[1]) >= 0;
    }

    greeting = greeting
      .replace(/^(您好|你好)[，,！!。\s]*([\u4e00-\u9fff]{1,4})(经理|老师|先生|女士)[，,！!。\s]*/, function(fullMatch, hello, prefix, title) {
        if (prefix.indexOf('我') >= 0 || isAllowedRoleLabel(prefix + title)) return fullMatch;
        return '您好，';
      })
      .replace(/^([\u4e00-\u9fff]{1,4})(经理|老师|先生|女士)[，,：:\s]*(您好|你好)[，,！!。\s]*/, function(fullMatch, prefix, title) {
        return isAllowedRoleLabel(prefix + title) ? fullMatch : '您好，';
      })
      .replace(/^([\u4e00-\u9fff]{2,4})[，,：:\s]*(您好|你好)[，,！!。\s]*/, function(fullMatch, label) {
        return isAllowedRoleLabel(label) ? fullMatch : '您好，';
      })
      .replace(/(^|[。！？!，,]\s*)我(是|叫)(候选人|求职者)?\s*([\u4e00-\u9fff]{2,4})[，,：:\s]*/g, function(fullMatch, prefix, verb, role, name) {
        if (allowedSelfDescriptions.indexOf(name) >= 0) return fullMatch;
        return prefix || '';
      })
      .replace(/(^|[。！？!，,]\s*)我(是|叫)(候选人|求职者)?\s*[A-Za-z][A-Za-z .'-]{1,30}(?=[，,。；;！!]|$)[，,：:\s]*/g, function(fullMatch, prefix) {
        return prefix || '';
      })
      .replace(/(^|[。！？!，,]\s*)我的名字(是|叫)\s*([\u4e00-\u9fff·]{2,8}|[A-Za-z][A-Za-z .'-]{1,30})[，,：:\s]*/g, function(fullMatch, prefix) {
        return prefix || '';
      })
      .replace(/(^|[，。！？；;]\s*)(候选人|求职者)?([\u4e00-\u9fff]{2,4})(?=具备|拥有|熟悉|擅长|希望|有|曾|对)/g, function(fullMatch, prefix, role, subject) {
        if (!role && allowedClauseSubjects.indexOf(subject) >= 0) return fullMatch;
        return prefix || '';
      })
      .replace(/[\u4e00-\u9fff]{1,2}(总|经理|老师|先生|女士)/g, function(fullMatch, title) {
        var prefix = fullMatch.slice(0, -title.length);
        if (prefix.length === 2 && ['与', '向', '和', '跟', '请'].indexOf(prefix.charAt(0)) >= 0) {
          return prefix.charAt(0) + '您';
        }
        return allowedRolePrefixes.indexOf(prefix) >= 0 ? fullMatch : '您';
      })
      .replace(/([与和跟向])([\u4e00-\u9fff]{2,4}?)(一起)?(?=协作|合作|沟通|交流|对接)/g, function(fullMatch, connector, label, together) {
        if (label.indexOf('您') === 0
          || label.indexOf('相关') === 0
          || isAllowedRoleLabel(label)
          || /(团队|同事|伙伴)$/.test(label)) return fullMatch;
        return connector + '相关人员' + (together || '');
      })
      .replace(/(服务过|对接过|负责过|合作过|面向|支持过?)\s*[\u4e00-\u9fffA-Za-z0-9·]{2,12}客户/g, '$1相关客户')
      .replace(/((?:服务|支持|对接|合作)(?!过))\s*([\u4e00-\u9fffA-Za-z0-9·&_-]{2,20}?)(?=(?:供应链|业务|团队|平台|系统|客户))/g, function(fullMatch, verb, label) {
        return isLikelyOrganizationName(label) ? verb + '相关客户' : fullMatch;
      })
      .replace(/([为向给])\s*([\u4e00-\u9fffA-Za-z0-9·]{2,12})(?=交付|提供|搭建|实施|开发|服务)/g, function(fullMatch, connector, label) {
        return isAllowedRoleLabel(label) ? fullMatch : connector + '相关客户';
      })
      .replace(/(参与过?|负责过?|做过|完成|开展)\s*([\u4e00-\u9fffA-Za-z0-9·&_-]{2,16}?)(?=(?:数字化|供应链|制造|零售|电商|金融|医疗|客服|营销|业务)?项目)/g, function(fullMatch, verb, label) {
        return isLikelyOrganizationName(label) ? verb + '相关客户' : fullMatch;
      })
      .replace(/(?:此致[，,\s]*|[-—]{1,2}|(?:求职者|候选人|署名)[：:])\s*(?:[\u4e00-\u9fff]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})\s*$/, '')
      .replace(/(来自|加入|就职于|任职于)\s*[\u4e00-\u9fffA-Za-z0-9·]{2,20}(?=[，,。；;！!\s]|$)/g, '$1相关团队')
      .replace(/(在|于)\s*[\u4e00-\u9fffA-Za-z0-9·]{2,20}(?=负责|从事|担任|参与|完成|开展|实习|工作|做过)/g, '$1相关团队')
      .replace(/(在|于|来自|加入|就职于|任职于)[\u4e00-\u9fffA-Za-z0-9·]{2,20}(有限责任公司|股份有限公司|有限公司|公司|集团|银行|研究院|实验室|事务所|工作室|大学|学院|学校)/g, '$1相关团队')
      .replace(/(^|[，。！？；;\s])[\u4e00-\u9fffA-Za-z0-9·]{2,20}(有限责任公司|股份有限公司|有限公司|公司|集团|银行|研究院|实验室|事务所|工作室|大学|学院|学校)(?=[，。！？；;\s]|$)/g, '$1相关团队')
      .replace(/[，,]{2,}/g, '，')
      .replace(/\s+([，。！？])/g, '$1')
      .trim();

    uniqueIdentityStrings(blockedNames).forEach(function(name) {
      if (name.length >= 2) greeting = greeting.split(name).join('相关团队');
    });

    var remainingIdentity = greeting.match(
      /我(是|叫)(候选人|求职者)?\s*([\u4e00-\u9fff]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})/
    );
    if ((remainingIdentity && allowedSelfDescriptions.indexOf(remainingIdentity[3]) < 0)
      || /(?:此致|求职者[：:]|候选人[：:]|署名[：:])/.test(greeting)) return '';

    return greeting;
  }

  function extractGreetingBlockedNames(resumeText) {
    var text = String(resumeText || '').trim();
    if (!text) return [];
    var names = [];
    var lines = text.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(Boolean);
    var firstLine = lines[0] || '';
    var nonNameLabels = [
      '个人信息', '基本信息', '求职意向', '教育经历', '工作经历', '项目经历',
      '专业技能', '自我评价', '软件工程', '网络工程', '人工智能', '信息安全',
    ];
    var firstLineName = firstLine.match(/^([\u4e00-\u9fff·]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})(?=\s*(?:$|[|｜·-]))/);
    var firstCandidate = firstLineName && String(firstLineName[1] || '').trim();
    if (firstCandidate && nonNameLabels.indexOf(firstCandidate) < 0) names.push(firstCandidate);
    lines.slice(0, 12).forEach(function(line) {
      var headerName = line.match(/^([\u4e00-\u9fff·]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})(?=\s*[|｜·-])/);
      var candidate = headerName && String(headerName[1] || '').trim();
      if (candidate && nonNameLabels.indexOf(candidate) < 0) names.push(candidate);
    });
    var patterns = [
      /(?:^|\n)\s*(?:姓名|Name)\s*[：:]\s*([\u4e00-\u9fff·]{2,8}|[A-Za-z][A-Za-z .'-]{1,30})/gi,
      /(?:^|[。！？!，,\n]\s*)我(?:是|叫)\s*([\u4e00-\u9fff·]{2,4}|[A-Za-z][A-Za-z .'-]{1,30})(?=[，,。；;！!\s]|$)/g,
      /(?:^|[。！？!，,\n]\s*)我的名字(?:是|叫)\s*([\u4e00-\u9fff·]{2,8}|[A-Za-z][A-Za-z .'-]{1,30})(?=[，,。；;！!\s]|$)/g,
    ];
    patterns.forEach(function(pattern) {
      var match;
      while ((match = pattern.exec(text))) names.push(String(match[1] || '').trim());
    });
    return uniqueIdentityStrings(names.concat(extractGreetingOrganizationNames(text)));
  }

  function evaluateBossGreetingSafety(readResult) {
    if (!readResult
      || readResult.success !== true
      || typeof readResult.enabled !== 'boolean') {
      return {
        ok: false,
        errorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
        error: '无法确认 BOSS 自带自动招呼语是否关闭',
      };
    }
    if (readResult.enabled) {
      return {
        ok: false,
        errorCode: 'BOSS_DEFAULT_GREETING_ENABLED',
        error: 'BOSS 自带自动招呼语仍为开启状态',
        templateId: readResult.templateId,
      };
    }
    return { ok: true };
  }

  root.sanitizeGeneratedGreeting = sanitizeGeneratedGreeting;
  root.extractGreetingBlockedNames = extractGreetingBlockedNames;
  root.evaluateBossGreetingSafety = evaluateBossGreetingSafety;
})(typeof globalThis !== 'undefined' ? globalThis : self);
