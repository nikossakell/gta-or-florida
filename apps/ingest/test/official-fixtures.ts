/**
 * SYNTHETIC official documents for tests. They reproduce the real page STRUCTURE (verified 2026-11-24
 * on FWC GovDelivery bulletins and a Flagler County Sheriff release) but every sentence, name and number
 * is invented: no publisher text is committed to the repository.
 */

const li = (t: string) => `<li style="margin: 0 0 10px;">${t}</li>`;
const h3 = (t: string) => `<h3 style="text-align: left; line-height: 1.2;" align="left">${t}</h3>`;
const region = (name: string) =>
  `<a href="https://myfwc.com/law-enforcement/regions/x/" title="${name}"><img class="govd_template_image" src="https://content.govdelivery.com/attachments/fancy_images/FLFFWCC/2023/02/1/x.jpg" alt="${name}" width="570" height="25"></a>`;

export const FWC_URL = 'https://content.govdelivery.com/accounts/FLFFWCC/bulletins/3a1b2c3';

export const FWC_ROUTINE =
  'Officer Ledger observed two anglers fishing from a public pier. A resource inspection found that neither had a valid saltwater fishing license and that one had kept three undersized sheepshead. The violations were cited accordingly.';
export const FWC_GATOR =
  'Officers Sample and Testman stopped a pickup truck at a boat ramp to conduct a resource inspection. Officer Sample checked a cooler in the truck bed and found a small live alligator underneath several wet towels. The driver said he planned to keep it. The individual was arrested for illegal possession of an American alligator and booked into the county jail.';
export const FWC_LEMUR =
  'Investigator Rivera responded to a report of a ring-tailed lemur that had escaped from its enclosure at a private residence. The lemur was unable to be located after a search of the neighborhood. The owner received a citation for an inadequate enclosure.';
export const FWC_DEATH = 'Officers responded to a boating crash on a lake in which one person died. The investigation is ongoing.';
export const FWC_MINOR = 'Officers located two teens who had paddled a borrowed kayak far from shore after dark and escorted them back to the launch.';

export const FWC_BULLETIN = `<!DOCTYPE html><html><head>
<meta content='FWC Law Enforcement Weekly Reports: Jan. 3-9, 2025' property='og:title' />
<meta content='https://content.govdelivery.com/attachments/fancy_images/FLFFWCC/logo.png' property='og:image' />
</head><body>
<h1 class='bulletin_subject'>FWC Law Enforcement Weekly Reports: Jan. 3-9, 2025</h1>
<span class='dateline rs_skip'>Florida Fish &amp; Wildlife Conservation Commission sent this bulletin at 01/15/2025 10:05 AM EST</span>
<div class='bulletin_body' id='bulletin_body'>
${region('masthead')}
<h3 style="text-align: center;">January 3, 2025, through January 9, 2025</h3>
<p>This report represents some events the FWC handled over the specified week.</p>
${region('Northwest Region')}${h3('CASES')}${h3('Gulf County')}
<ul>${li(FWC_ROUTINE)}</ul>
${h3('<strong>Lee County</strong>')}
<ul>${li(FWC_GATOR)}${li(FWC_DEATH)}</ul>
${region('South A Region')}${h3('CASES')}${h3('Broward County')}
<ul>${li(FWC_LEMUR)}${li(FWC_MINOR)}</ul>
${region('Wildlife Alert banner')}
<p>Patrol, Protect, Preserve</p>
<p>SUBSCRIBER SERVICES: manage your preferences.</p>
</div></body></html>`;

export const FLAGLER_URL = 'https://flaglersheriff.com/news/gorilla-masked-man-arrested-after-store-robbery/';
export const FLAGLER_HEADLINE = 'Gorilla-Masked Robber Threatens Bunnell Cashier, Caught Minutes Later';

export const FLAGLER_RELEASE = `<!DOCTYPE html><html lang="en-US"><head>
<title>Gorilla-Masked Robber Threatens Bunnell Cashier, Caught Minutes Later - Flagler County Sheriff&#039;s Office</title>
<meta property="og:title" content="${FLAGLER_HEADLINE} - Flagler County Sheriff&#039;s Office ">
<meta property="og:image" content="https://flaglersheriff.com/wp-content/uploads/2026/11/booking.jpeg">
<meta property="og:image:alt" content="Jordan Testcase Sample (FCSO booking photo)">
</head><body>
<header><h1 class="wp-block-heading">EXAMPLE SHERIFF</h1></header>
<main id="main-content"><div class="entry-content">
<p>NEWS RELEASE</p>
<h1>${FLAGLER_HEADLINE}</h1>
<p><strong>Date:</strong>Tuesday, November 10, 2026</p>
<p>On Saturday night, the Flagler County Sheriff’s Office arrested a man accused of robbing a Bunnell convenience store while wearing a gorilla mask.</p>
<p>At about 9:15 p.m. on Nov. 7, deputies responded to a robbery call at the convenience store on Example Road.</p>
<p>Moments earlier, a man wearing a gorilla mask walked in holding a towel over one hand. He pointed the towel at the cashier as if a weapon was under it and demanded the money in the register.</p>
<p>The cashier handed over the cash and the man left on a bicycle. A deputy found the bicycle and a gorilla mask behind a nearby car wash.</p>
<p>Deputies located Jordan Testcase Sample, 34, of Daytona Beach, a short distance away. Sample was arrested for robbery and is being held at the county detention facility.</p>
<p>Sample denied being at the store.</p>
<p><img src="https://flaglersheriff.com/wp-content/uploads/2026/11/booking.jpeg" alt="booking photo"></p>
<p>Jordan Sample (FCSO booking photo)</p>
<p>“Wearing a mask does not make anyone invisible,” said Sheriff Example.</p>
<p>Sample’s previous arrests include burglary and grand theft.</p>
<ul><li>Prepared By:Public Information Officer</li><li>Release:#2026 - 999</li></ul>
</div>
<p>Florida has a very broad public records law per Florida State Statute 119.</p>
</main></body></html>`;
