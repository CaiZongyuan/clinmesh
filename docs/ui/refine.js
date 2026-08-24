(function(){
  'use strict';

  var body = document.body;
  var openPopover = null;
  var toastTimer = null;

  function showToast(message){
    var old = document.querySelector('.ui-toast');
    if(old) old.remove();
    window.clearTimeout(toastTimer);
    var el = document.createElement('div');
    el.className = 'ui-toast';
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    toastTimer = window.setTimeout(function(){ el.remove(); }, 2400);
  }

  function closePopover(){
    if(openPopover){
      openPopover.remove();
      openPopover = null;
    }
  }

  function placePopover(popover, anchor){
    document.body.appendChild(popover);
    var rect = anchor.getBoundingClientRect();
    var width = popover.offsetWidth;
    var left = Math.min(rect.left, window.innerWidth - width - 10);
    popover.style.left = Math.max(10, left) + 'px';
    popover.style.top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 10) + 'px';
    openPopover = popover;
  }

  function setTheme(dark){
    body.classList.toggle('theme-dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelectorAll('.switch-row').forEach(function(toggle){
      toggle.setAttribute('aria-pressed', String(dark));
    });
    try{ localStorage.setItem('ankang-theme', dark ? 'dark' : 'light'); }catch(error){}
  }

  var savedTheme = null;
  try{ savedTheme = localStorage.getItem('ankang-theme'); }catch(error){}
  setTheme(savedTheme === 'dark');

  document.querySelectorAll('.switch-row').forEach(function(toggle){
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('tabindex', '0');
    toggle.setAttribute('aria-label', '切换夜间模式');
    function switchTheme(){ setTheme(!body.classList.contains('theme-dark')); }
    toggle.addEventListener('click', switchTheme);
    toggle.addEventListener('keydown', function(event){
      if(event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        switchTheme();
      }
    });
  });

  var activeFilter = '';
  var searchTerm = '';
  var waitingRows = Array.prototype.slice.call(document.querySelectorAll('.table-card tbody tr'));

  function applyWaitingFilters(){
    waitingRows.forEach(function(row){
      var text = row.textContent.replace(/\s+/g, '').toLowerCase();
      var statusMatches = !activeFilter ||
        (activeFilter === '候诊中' && text.indexOf('候诊中') > -1) ||
        (activeFilter === '已接诊' && (text.indexOf('已确认') > -1 || text.indexOf('接诊中') > -1)) ||
        (activeFilter === '已退号' && text.indexOf('已退号') > -1);
      var searchMatches = !searchTerm || text.indexOf(searchTerm) > -1;
      row.hidden = !(statusMatches && searchMatches);
    });
  }

  document.querySelectorAll('.filter').forEach(function(filter){
    filter.setAttribute('role', 'button');
    filter.setAttribute('tabindex', '0');
    function activate(){
      var group = filter.parentElement;
      group.querySelectorAll('.filter').forEach(function(item){ item.classList.remove('on'); });
      filter.classList.add('on');
      var label = filter.textContent.trim();
      activeFilter = label.indexOf('全部') === 0 ? '' : label.split(/\s/)[0];
      applyWaitingFilters();
    }
    filter.addEventListener('click', activate);
    filter.addEventListener('keydown', function(event){
      if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); activate(); }
    });
  });

  document.querySelectorAll('.search input').forEach(function(input){
    input.addEventListener('input', function(){
      searchTerm = input.value.trim().replace(/\s+/g, '').toLowerCase();
      applyWaitingFilters();
      document.querySelectorAll('.queue__list .q-item').forEach(function(item){
        var matches = !searchTerm || item.textContent.replace(/\s+/g, '').toLowerCase().indexOf(searchTerm) > -1;
        item.hidden = !matches;
      });
    });
  });

  document.querySelectorAll('.btn-add').forEach(function(button){
    button.setAttribute('aria-haspopup', 'menu');
    button.addEventListener('click', function(event){
      event.stopPropagation();
      if(openPopover){ closePopover(); return; }
      var menu = document.createElement('div');
      menu.className = 'quick-menu';
      menu.setAttribute('role', 'menu');
      [
        ['新建患者档案', '登记基本信息并创建门诊号'],
        ['新增预约', '安排医生、科室与接诊时段'],
        ['发起检查申请', '快速开立检验或影像申请']
      ].forEach(function(item){
        var option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'menuitem');
        option.innerHTML = item[0] + '<span>' + item[1] + '</span>';
        option.addEventListener('click', function(){ closePopover(); showToast(item[0] + '入口已打开'); });
        menu.appendChild(option);
      });
      placePopover(menu, button);
    });
  });

  var topbarIcons = document.querySelectorAll('.topbar .icon-btn');
  if(topbarIcons[0]){
    topbarIcons[0].setAttribute('role', 'button');
    topbarIcons[0].setAttribute('tabindex', '0');
    topbarIcons[0].setAttribute('aria-label', '查看通知');
    topbarIcons[0].addEventListener('click', function(event){
      event.stopPropagation();
      if(openPopover){ closePopover(); return; }
      var menu = document.createElement('div');
      menu.className = 'notice-menu';
      menu.innerHTML = '<div class="notice-menu__head">待处理通知 · 3</div>' +
        '<div class="notice-menu__item"><i class="notice-menu__dot"></i><span>周建国血钾复测仍偏高，等待确认</span></div>' +
        '<div class="notice-menu__item"><i class="notice-menu__dot"></i><span>心电图机 #3 将于 17:00 停机维护</span></div>' +
        '<div class="notice-menu__item"><i class="notice-menu__dot"></i><span>医保目录 v3.2 已完成同步</span></div>';
      placePopover(menu, topbarIcons[0]);
    });
  }
  if(topbarIcons[1]){
    topbarIcons[1].setAttribute('role', 'button');
    topbarIcons[1].setAttribute('tabindex', '0');
    topbarIcons[1].setAttribute('aria-label', '打开系统设置');
  }

  function tableToCsv(table){
    return Array.prototype.map.call(table.rows, function(row){
      return Array.prototype.map.call(row.cells, function(cell){
        return '"' + cell.innerText.trim().replace(/"/g, '""').replace(/\s+/g, ' ') + '"';
      }).join(',');
    }).join('\n');
  }

  function downloadText(content, filename, type){
    var blob = new Blob(['\uFEFF' + content], {type:type});
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function(){ URL.revokeObjectURL(url); }, 0);
  }

  document.querySelectorAll('.btn-export').forEach(function(button){
    button.addEventListener('click', function(){
      var table = document.querySelector('.table-card table');
      if(!table){ showToast('当前页面没有可导出的列表'); return; }
      downloadText(tableToCsv(table), '安康门诊-候诊列表-20260823.csv', 'text/csv;charset=utf-8');
      showToast('候诊列表已导出');
    });
  });

  document.querySelectorAll('.page-patient .btn-ghost').forEach(function(button){
    var text = button.textContent.trim();
    if(text.indexOf('发消息') > -1){
      button.addEventListener('click', function(){ showToast('已打开与周建国的消息会话'); });
    }
    if(text.indexOf('导出病历') > -1){
      button.addEventListener('click', function(){
        var record = '患者：周建国\n档案：M-0128\n更新时间：2026-08-23 14:32\n\n当前诊断：高血压 3 级、2 型糖尿病、头晕待查\n过敏史：青霉素（皮疹）';
        downloadText(record, '周建国-M-0128-病历摘要.txt', 'text/plain;charset=utf-8');
        showToast('病历摘要已导出');
      });
    }
  });

  var mobileViewToggle = document.querySelector('.mobile-view-toggle');
  if(mobileViewToggle){
    mobileViewToggle.addEventListener('click', function(){
      var showingChat = body.classList.toggle('show-mobile-chat');
      mobileViewToggle.setAttribute('aria-pressed', String(showingChat));
      mobileViewToggle.setAttribute('aria-label', showingChat ? '返回病历工作区' : '切换协诊对话');
      mobileViewToggle.setAttribute('title', showingChat ? '返回病历工作区' : '切换协诊对话');
    });
  }

  document.addEventListener('click', closePopover);
  window.addEventListener('resize', closePopover);
  document.addEventListener('keydown', function(event){ if(event.key === 'Escape') closePopover(); });
})();
