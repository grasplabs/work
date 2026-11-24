-- GRA-1084: the onboarding's statements were one person's fact each. The
-- brain now holds only claims five or more of a team's people made, put
-- together, so every statement the onboarding gave it before goes; the
-- onboarding gives its teams again (its own migration marks them due).
DELETE FROM `brain_records` WHERE `type` = 'statement' AND `id` LIKE 'onb-st-%';
