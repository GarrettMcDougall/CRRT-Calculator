# Clinical and technical review

Reviewed: 2026-08-10

This revision corrects calculation and teaching errors in the supplied app. It remains an educational scaffold until the local protocol file has been completed and approved.

## Corrected in this revision

- Fixed multi-digit entry. The prior interface rebuilt the entire calculator after every keystroke, causing the active field to lose focus.
- Added a guided starting-flow calculator. It works backward from target delivered dose, expected uptime, modality, net UF, citrate volume, and pre-dilution.
- Corrected filtration fraction. Total ultrafiltration now includes pre-filter replacement, post-filter replacement, pre-filter citrate fluid, and net UF. The former calculation omitted all pre-filter replacement.
- Corrected total ultrafiltration. The former output included only post-filter replacement and net UF.
- Counted all citrate solutions as pre-filter fluid. The former ACD-A and 4% trisodium citrate presets incorrectly excluded their volume from effluent and pre-dilution.
- Replaced the fixed "prescribe 25–30" rule with a calculation based on a delivered target of 20–25 mL/kg/h.
- Changed the generic citrate starting range to 3–4 mmol/L blood, with 3.0 mmol/L as the initial suggestion.
- Changed generic heparin guidance to a 500–1000 unit bolus and 5–10 U/kg/h infusion. The bolus can be set to zero. Local nomograms remain authoritative.
- Removed the direct conversion of estimated calcium loss into an infusion rate of undiluted calcium chloride or gluconate. Prepared infusion concentrations and titration rules differ by site.
- Hid calcium titration instructions until every local nomogram row and the overall protocol are marked reviewed.
- Corrected the active-bleeding teaching case. Regional citrate is generally preferred over systemic heparin when suitable. No anticoagulation is a fallback when citrate is unsuitable or unavailable.
- Corrected the definition of total UF in theory, cases, and quiz content.
- Replaced the unsupported claim that hypophosphataemia is "near-universal by 24–48 hours" with the more accurate statement that it is common and requires proactive monitoring.
- Removed fixed catheter lengths from the teaching builder. Catheter length must match anatomy, device design, access site, and confirmed tip position.
- Clarified that a sodium gradient is a warning signal, not a prediction of the 24-hour correction rate.
- Reorganized the supplied flat files into the directory structure required by the HTML paths and renamed the entry file to `index.html`.

## Local decisions still required

- Exact machine and circuit, including Prismaflex or PrisMax set, membrane, and flow limits.
- Actual citrate products, concentrations, compatible dialysate/replacement solutions, and whether the local protocol uses calcium-containing or calcium-free fluids.
- Prepared calcium infusion product, bag concentration, starting rate, route, systemic iCa target, post-filter iCa target, and titration increments.
- Heparin solution concentration, bolus policy, aPTT or anti-Xa target, monitoring interval, and titration nomogram.
- Dosing-weight method for obesity.
- Potassium, bicarbonate, phosphate, sodium, magnesium, and glucose solution-selection rules.
- Lab timing at initiation, after changes, once stable, and during suspected citrate accumulation.
- Net UF titration boundaries and which changes nursing may make without a new physician order.
- Severe dysnatraemia workflow. A production version should calculate a patient-specific correction trajectory and explicitly account for all sodium and free-water inputs.
- Hyperammonaemia, tumour lysis, toxin, and refractory hyperkalaemia pathways that may require a dose outside the routine 20–25 mL/kg/h target.
- Medication-dosing links or tables maintained by local pharmacy.

## Recommended next build

1. Convert the local protocol JSON into a required setup wizard. The app should remain in study mode until every mandatory product and nomogram field is approved.
2. Add a complete order summary generated from the live calculator, including solutions, anticoagulation, monitoring, titration limits, and a review checklist.
3. Add decision inputs for bleeding risk, existing systemic anticoagulation, HIT, liver failure, shock, lactate trend, and local citrate capability. Use these to guide anticoagulation selection.
4. Add separate normal-sodium and dysnatraemia workflows.
5. Add automated browser tests for typing, focus retention, modality switching, applying suggestions, mobile layout, printing, and every config-review lockout.
6. Add PWA files only after the local protocol is validated. Offline caching can otherwise preserve an obsolete clinical protocol on users' phones.

## Evidence base used for this review

- [KDIGO 2012 Clinical Practice Guideline for Acute Kidney Injury](https://kdigo.org/wp-content/uploads/2016/10/KDIGO-2012-AKI-Guideline-English.pdf)
- [KDIGO 2026 AKI and AKD Guideline public-review draft](https://kdigo.org/wp-content/uploads/2026/03/KDIGO-2026-AKI-AKD-Guideline-Public-Review-Draft-March-2026.pdf)
- [UK Kidney Association Acute Kidney Injury guideline](https://renal.org/sites/renal.org/files/FINAL-AKI-Guideline.pdf)

The 2026 KDIGO document is a public-review draft, not a final guideline. The app labels local values as unreviewed until the site's approved protocol replaces them.
