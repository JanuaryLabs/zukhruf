# Labelling rule: news profiles

TREC-style topic statements. Written and hashed before the first label.

## Rules for every profile

- Main-subject test: the headline, or the lead when the headline is unclear, must be about the profile's subject. A subject that is one item in a list, a passing mention or background does not count.
- An article can be relevant to several profiles, or to none.
- Opinion, analysis and interviews count when their main subject is the profile's subject.
- A business article (funding, deal, acquisition, results, hire) is relevant to a subject profile only when it describes the subject's work (the product, technology, research or problem). An article that only names a company in the field is not relevant. The biology profile keeps its own stricter rule.
- Ambiguous (relevant: null): the main-subject test gives two answers. Record the alternative label and the reason.

Label values: `true` (relevant), `null` (ambiguous: give the alternative and the reason).
Every profile you do not list for an article is not relevant (`false`).

## `biology`: Biology

Description: New biology science, even when it comes from tech companies.

Relevant: An article is relevant when its main subject is a biological or life-science result, method, model, dataset or tool. Examples: protein design, genomics, drug-discovery science, neuroscience findings, ecology, AlphaFold-type models, and lab or biosecurity research results. The publisher does not matter: biology from an AI company (example: Anthropic's post on a designed protein that blocks scorpion venom) is relevant.

Not relevant when:

1. it is about the business or finance of bio or health companies and the article holds no science (funding, stocks, deals, partnerships, hires). Example: "biotech stocks fall 5%"
2. it is about policy or regulation and biology is only mentioned
3. it is a product launch that only names health or life-science customers
4. it is general AI news (models, safety, agents, chips, lawsuits) where biology is at most one item in a list

Main-subject test: The headline, or the lead when the headline is unclear, must be about the biological or life-science work. A science result inside a business article counts only when that result is the article's subject.

Ambiguous, typical cases: an AI-for-science programme that names biology among other sciences; a biosecurity policy or evaluation that reports no lab result; a health product whose article reports clinical or study results; a bio partnership that describes the science it will do.

## `chips`: Chips and AI hardware

Description: New computer chips and AI hardware, and how chips are made and supplied.

Relevant: The main subject is processors, GPUs, AI accelerators, memory chips, chip design, chip manufacturing (fabs, foundries, packaging), chip supply or shortages, rules on chip exports, or AI servers and supercomputers as hardware.

Not relevant when:

1. a data-center project, lease or cloud deal where the chips are not the subject
2. a consumer device (phone, laptop, headset) launch, unless the chip inside it is the subject
3. AI model or software news that names the hardware it runs on

Ambiguous, typical cases: a chip company's financial results; a cloud-capacity deal that names the number and type of chips; a device launch that leads with its new chip.

## `security`: Cybersecurity

Description: Cybersecurity: attacks, breaches, vulnerabilities and the tools and research that defend against them.

Relevant: The main subject is a cyberattack, data breach, ransomware, a vulnerability or patch, threat research, a security product or service, AI used to attack or defend systems, or attacks on AI systems (for example prompt injection against agents).

Not relevant when:

1. research on how AI models behave that reports no attack or defence (that is the safety profile)
2. physical security, public safety or national defence with no computer-security subject
3. privacy policy or regulation with no attack, breach or security tool

Ambiguous, typical cases: a privacy failure (data exposed by a bug) that nobody attacked; fraud or scams that use AI with no computer intrusion; a general platform launch with one security feature in the headline.

## `funding`: Funding and acquisitions

Description: Startup funding rounds, investments and company acquisitions.

Relevant: The main subject is a funding round, a venture or strategic investment in a company, a valuation, an IPO, or an acquisition or merger (rumoured, announced, completed or blocked).

Not relevant when:

1. company financial results (that is the company-results profile)
2. government grants, subsidies or public spending programmes
3. a company's own capital spending (for example a plan to spend billions on data centers)
4. a partnership with no equity or purchase

Ambiguous, typical cases: a compute or cloud deal described as an investment; a fund (a venture firm raising its own fund) with no company named; a share sale by employees (tender offer).

## `regulation`: Tech regulation and policy

Description: Government laws, regulations and policy on AI and technology.

Relevant: The main subject is a law, bill, regulation, executive order, government policy, a regulator's action (fine, investigation, ruling by an agency), export controls, or an international agreement on AI or technology.

Not relevant when:

1. a lawsuit between private parties or a court ruling (that is the lawsuits profile), unless a government brought the case
2. a company's own policy, terms or principles
3. politics or elections with no technology policy

Ambiguous, typical cases: AI-company lobbying or political spending; a government contract to buy or use AI; a government lawsuit (relevant here and to lawsuits).

## `courts`: Lawsuits and court rulings

Description: Lawsuits, court cases and legal rulings that involve AI or tech companies.

Relevant: The main subject is a lawsuit, a court ruling, a trial, a settlement or a legal dispute (copyright, antitrust, privacy, defamation, contract, employment) that involves an AI or tech company, or a court case about the use of AI (for example invented citations in a filing).

Not relevant when:

1. a law or regulation with no court case (that is the regulation profile)
2. a patent granted or a contract signed with no dispute

Ambiguous, typical cases: a threat to sue or a legal letter; an investigation by a regulator that is not in a court; a criminal arrest with no AI or tech subject.

## `robotics`: Robotics

Description: Robots and autonomous machines: humanoids, industrial robots, drones and self-driving vehicles.

Relevant: The main subject is a physical robot, a robot AI model (for example vision-language-action models), humanoids, industrial or warehouse robots, drones, self-driving cars or robotaxis.

Not relevant when:

1. software bots, chatbots, or AI agents that act only in software
2. robotic process automation (RPA) software

Ambiguous, typical cases: world-model or simulation research that names robots as one use; a factory-automation product with no robot in the article.

## `safety`: AI safety research

Description: Research on AI safety and alignment: how AI models misbehave, how to test them and how to make them safe.

Relevant: The main subject is alignment research, interpretability, evaluations of dangerous capabilities, studies of model misbehaviour (scheming, deception, sycophancy, reward hacking), red-teaming or jailbreak results, or the safety findings of a system card.

Not relevant when:

1. AI policy or regulation that reports no research result (that is the regulation profile)
2. cyberattacks or security products with no model-behaviour subject (that is the cybersecurity profile)
3. a product safety feature (for example parental controls) with no research
4. a model launch that mentions safety in passing

Ambiguous, typical cases: an AI lab's safety policy or framework update with no new result; a case where a chatbot harmed a user that reports only the case or the lawsuit, not the model's behaviour.

## `open-models`: Open-weight models

Description: New AI models released with open weights that anyone can download.

Relevant: The main subject is the release of an AI model whose weights anyone can download (open weights, open source, or a research licence), or tests and analysis of such a released model.

Not relevant when:

1. models available only through an API or an app
2. open-source software that is not a model (frameworks, tools, agents)
3. datasets

Ambiguous, typical cases: a plan or promise to release open weights later; a model family where only some sizes are open and the article is about a closed one.

## `jobs`: AI and jobs

Description: How AI changes work: jobs, hiring, layoffs, wages and skills.

Relevant: The main subject is the effect of AI on employment, layoffs or hiring linked to AI, studies of the workforce, wages or productivity of workers who use AI, skills and retraining, or unions and AI.

Not relevant when:

1. layoffs or hiring that the article does not link to AI
2. executive appointments or departures

Ambiguous, typical cases: the competition for AI researchers (pay packages, poaching); training courses for professionals with no work-effect subject.

## `energy`: Energy for computing

Description: Electricity and energy for computing: power supply, power plants and the energy use of data centers and AI.

Relevant: The main subject is how power for data centers or AI is produced, bought or delivered (power plants, nuclear, renewables, grid connections), power demand of data centers, or studies of the energy use of AI.

Not relevant when:

1. a data-center project that gives its size in megawatts or gigawatts but is not about the power supply
2. climate or energy news with no computing subject

Ambiguous, typical cases: data-center cooling and water use; an energy company's AI software product.

## `quantum`: Quantum computing

Description: Quantum computing hardware, software and research.

Relevant: The main subject is quantum computers, qubits, quantum algorithms or error correction, or the products and research of quantum-computing companies.

Not relevant when:

1. the word quantum used for something that is not quantum computing

Ambiguous, typical cases: post-quantum cryptography; quantum sensing or quantum networking with no computer.

## `health`: Health and medicine

Description: AI and technology in medicine and healthcare: diagnosis, clinical care, hospitals and health products.

Relevant: The main subject is medical AI (diagnosis, imaging), a clinical study of an AI tool, health apps or products, hospitals or health systems that use technology, health data, or medical advice from chatbots.

Not relevant when:

1. life-science research with no care or clinical use (that is the biology profile)
2. a product launch that only names health customers

Ambiguous, typical cases: a drug-discovery result before any clinical study; mental-health effects of chatbots on users; a case where a chatbot harmed a user.

## `education`: Education

Description: AI and technology in education: schools, universities, teachers, students and learning tools.

Relevant: The main subject is AI or technology in schools or universities, students or teachers who use AI, cheating, education products, or AI-literacy programmes for students.

Not relevant when:

1. the word learning in the machine-learning sense
2. research done at a university that is not about education

Ambiguous, typical cases: training courses for professionals; an AI company's free programme for students that is mainly a promotion.

## `coding`: AI for software development

Description: AI for software development: coding assistants, coding agents and developer tools.

Relevant: The main subject is an AI coding assistant or coding agent, a developer tool that uses AI, an app builder that writes code from prompts, studies of AI-assisted programming, or coding benchmark results.

Not relevant when:

1. developer tools or platforms with no AI subject
2. a model launch that reports coding scores among other results

Ambiguous, typical cases: security flaws in code written by AI; a general agent platform whose main example is coding.

## `earnings`: Company results

Description: Company financial results: quarterly earnings, revenue, profit and forecasts.

Relevant: The main subject is a company's earnings report, revenue or profit figures, a revenue run-rate, a forecast or guidance, or a stock move caused by results.

Not relevant when:

1. funding rounds and valuations (that is the funding profile)
2. market-share studies or analyst predictions with no company result

Ambiguous, typical cases: a stock move with no results; spending plans announced in an earnings call when the article is about the spending.

## Procedure

- One annotator per article: Claude (Opus 5.5). A random 400 articles get a second, independent annotator.
- Label from the title and the lead; read the body when the lead is unclear.
- Read every article in your queue. Do not scan or filter by keywords.
- Blind: no model output, embeddings, scores, keyword lists or earlier labels are used.
