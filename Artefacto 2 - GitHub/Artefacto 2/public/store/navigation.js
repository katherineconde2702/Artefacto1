const trigger=document.querySelector('[data-store-menu]');
if(trigger){
  const menu=document.createElement('dialog');menu.id='store-menu';menu.className='store-menu';
  menu.setAttribute('aria-labelledby','store-menu-title');
  menu.innerHTML='<button type="button" class="store-menu-close" aria-label="Cerrar menú">×</button><h2 id="store-menu-title">Explorá MAREA</h2><nav aria-label="Menú de MAREA"><a href="/#collection">Colección</a><a href="/?guardadas=1#collection">Prendas guardadas</a><a href="/product/?id=soft-knit-sweater#try">Encontrá tu talle con TRY</a><a href="/checkout/">Bolsa y envíos</a><a href="/#story">Nuestra filosofía</a><a href="/#materials">Materiales y cuidado</a></nav>';
  document.body.append(menu);trigger.setAttribute('aria-controls',menu.id);trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>{menu.showModal();trigger.setAttribute('aria-expanded','true');});
  menu.querySelector('button').addEventListener('click',()=>menu.close());
  menu.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>menu.close()));
  menu.addEventListener('click',event=>{if(event.target===menu){const rect=menu.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)menu.close();}});
  menu.addEventListener('close',()=>{trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});});
}
