const opts=[...document.querySelectorAll('.bundle')],buy=document.getElementById('buy'),buy2=document.getElementById('buy2'),sb=document.getElementById('sb-label');
opts.forEach(o=>o.addEventListener('click',()=>{opts.forEach(x=>x.setAttribute('aria-checked','false'));o.setAttribute('aria-checked','true');
 buy.href=buy2.href=o.dataset.link;buy.textContent='Buy '+o.dataset.label+' →';sb.textContent=o.dataset.label;}));
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
