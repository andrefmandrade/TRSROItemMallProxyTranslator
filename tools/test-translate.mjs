import { loadDictionary, createTranslator } from '../src/translate.mjs';

const sample = [
  '<li class="silk current"><a href="itemBuyGame_default.asp?st0=0">Mağaza </a></li>',
  '<h2>Silk Rütbesi</h2>',
  '<span class="name">Ottoman Emperor Dress (M)</span>',
  '<strong class="current">260&nbsp;Silk</strong>',
  '<dt> -Aylık Kullanım : </dt><dd>2100 Silk</dd>',
  '<li><strong>Açıklama</strong><br />Kullanım kısıtlaması yoktur.</li>',
  '<a href="#" onclick="location.href=\'/itemmall/itemBuyGame/itemBuyGame.asp?package_id=3898\'">Satın Al </a>',
  '<li><a href="x?st2=1">Büyüme Pet</a></li><li><a href="y">Büyüme</a></li>',
].join('\n');

const script = "<script>alert('Bu eşyayı satın almak için karakterinizin seviyesi en az 96 olmalıdır.');</script>";
const html = sample + '\n' + script;

const { rewrite, stats } = createTranslator(loadDictionary());
const out = rewrite(html);

const check = (label, pass) => console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
check('chrome translated (Store / Silk Rank / Buy)', /Store/.test(out) && /Silk Rank/.test(out) && /Buy/.test(out));
check('tooltip label translated (Description)', /Description/.test(out));
check('stock phrase translated', /no usage restrictions/i.test(out));
check('longest-match first (Growth Pet intact)', /Growth Pet/.test(out) && !/Growth Pet Pet/.test(out));
check('package_id untouched', out.includes('package_id=3898'));
check('href/onclick untouched', out.includes("itemBuyGame_default.asp?st0=0"));
check('price text untouched', out.includes('260&nbsp;Silk'));
check('Silk balance untouched', out.includes('2100 Silk'));
check('script body untouched', out.includes(script));
check('every number preserved', (html.match(/\d+/g) || []).join() === (out.match(/\d+/g) || []).join());
console.log(`\n  ${stats.changed} chunks translated, ${stats.reverted} reverted by the number guard`);
