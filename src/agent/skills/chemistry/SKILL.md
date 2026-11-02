---
name: chemistry
description: Chemical formulas, ions, isotopes, reaction equations (KaTeX mhchem \ce and \pu), grading OCR/plain-text chemical answers, and 2D molecular structures or mechanisms via visual.
---

## Chemistry — notation, grading, and visual craft

Guidance for teaching chemistry, writing chemical questions and practice problems, evaluating learner work, and requesting molecular figures.

### 1. KaTeX `mhchem` formatting (`\ce{...}` and `\pu{...}`)

The application renders mathematics and chemistry through KaTeX with `mhchem` enabled. Use `\ce{...}` for all chemical formulas and `\pu{...}` for physical units:

- **Inline chemical notation (`$\ce{...}$`)**:
  - Chemical formulas: `$\ce{H2O}$`, `$\ce{CO2}$`, `$\ce{C6H12O6}$`
  - Hydrates and states: `$\ce{CuSO4 . 5H2O}$`, `$\ce{NaCl(aq)}$`, `$\ce{CaCO3(s)}$`
  - Charged ions and complexes: `$\ce{SO4^2-}$`, `$\ce{Fe^3+}$`, `$\ce{[Fe(CN)6]^4-}$`
  - Isotopes and nuclides: `$\ce{^14_6C}$`, `$\ce{^238_92U}$`
  - Bonds and skeletal connectivity: `$\ce{CH3-CH=CH2}$`, `$\ce{H-C#C-H}$`
- **Standalone reaction and equilibrium equations (`$$\ce{...}$$`)**:
  - Write reaction equations fenced with `$$\ce{...}$$` on separate lines:
    $$\ce{N2 + 3H2 <=> 2NH3}$$
  - Reaction arrows, conditions, and precipitates:
    $$\ce{A ->[H2O][\Delta] B}$$
    $$\ce{Ag+ + Cl- -> AgCl v}$$
- **Physical units and scientific quantities (`$\pu{...}$`)**:
  - Use `$\pu{...}$` for quantities and units: `$\pu{1.23e4 kJ/mol}$`, `$\pu{-285.8 kJ mol-1}$`, `$\pu{8.314 J/(mol K)}$`, `$\pu{1.00 atm}$`.
- **Consistency across all surfaces**:
  - Apply `\ce{...}` and `\pu{...}` across all fields: teaching prose, quiz questions, quiz options, explanations, and practice problem statements and model solutions. Never leave plain-text chemistry formulas like `H2SO4` or `SO4^2-` in questions or options.
- **JSON escaping in tool arguments**:
  - Inside JSON string arguments (`quiz`, `probe`, `explain`, `recall`, `problem`, etc.), double every LaTeX backslash: `"$\\ce{H2O}$"`, `"$\\ce{SO4^2-}$"`, `"$$\\n\\ce{N2 + 3H2 <=> 2NH3}\\n$$"`.

### 2. Grading & reading learner chemical notation leniently

- Learner `thinking`, `thinkingWhileReading`, free-recall answers, and practice work may arrive from speech dictation, keyboard typing, or handwriting OCR (Quaderno).
- Read plain-text or slightly noisy chemical notation (e.g., `H2O`, `SO4^2-`, `SO4 2-`, `->`, `<=>`, `delta H`) leniently for its intended chemical meaning.
- Grade chemistry on conceptual accuracy and stoichiometry, never penalizing missing LaTeX formatting or minor OCR transcription noise in learner responses.

### 3. 2D chemical structures and reaction mechanisms (`visual` tool)

- Use the `visual` tool for exact 2D static figures that inline Markdown or auto-layout diagrams cannot express:
  - Skeletal (line-angle) structures and stereochemical wedges/dashes.
  - Lewis structures complete with explicit lone pairs and formal charges.
  - Reaction mechanisms with curved electron-pushing arrows (single-barbed for radicals, double-barbed for pairs).
  - Reaction-coordinate diagrams (activation energy $E_a$, transition states $\ddagger$, intermediates) and molecular-orbital energy diagrams.
- **Authoring the `brief`**:
  - Specify exact atom connectivity, ring geometry (e.g., regular 120° hexagons for cyclohexane/benzene), heteroatom labels, stereocenters, formal charges, and exact origin and target atoms/bonds for curved electron-pushing arrows.
