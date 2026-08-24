from app.services.transcription_prompt import (
    DECODER_CONTEXT_TOKENS,
    FASTER_WHISPER_PART_CAP,
    build_initial_prompt,
    estimate_tokens,
    harvest_terms,
    normalize_hotwords,
    parse_terms,
    prompt_budget,
)



def word_counter(text: str) -> int:
    """Stand-in for a real tokenizer: one token per whitespace-separated word."""
    return len(text.split())


class TestParseTerms:
    def test_splits_on_commas_semicolons_and_newlines(self):
        assert parse_terms("SFO; proceeds of crime\nAML, disclosure") == [
            "SFO",
            "proceeds of crime",
            "AML",
            "disclosure",
        ]

    def test_collapses_inner_whitespace_and_trims(self):
        assert parse_terms("  forensic   accounting  ") == ["forensic accounting"]

    def test_dedupes_case_insensitively_keeping_first_spelling(self):
        assert parse_terms("SFO, sfo, Sfo") == ["SFO"]

    def test_drops_empties_and_oversized_chunks(self):
        long_chunk = "x" * 61
        assert parse_terms(f"AML, , {long_chunk}, POCA") == ["AML", "POCA"]

    def test_empty_input(self):
        assert parse_terms(None) == []
        assert parse_terms("   ") == []


class TestPromptBudget:
    def test_leaves_room_for_the_decoder_to_actually_emit(self):
        # The whole point: prompt + output share one 448-token budget.
        budget = prompt_budget()
        assert budget + 200 < DECODER_CONTEXT_TOKENS

    def test_never_exceeds_the_per_part_cap_faster_whisper_enforces(self):
        assert prompt_budget(output_headroom=0) <= FASTER_WHISPER_PART_CAP

    def test_deployment_glossary_takes_its_share_first(self):
        # hotwords and the prompt are separate parts that stack in the same
        # window, so a big glossary has to shrink the per-recording prompt.
        assert prompt_budget(hotwords_tokens=150) < prompt_budget(hotwords_tokens=0)

    def test_never_negative_when_the_glossary_is_enormous(self):
        assert prompt_budget(hotwords_tokens=10_000) == 0


class TestHarvestTerms:
    def test_picks_up_acronyms(self):
        assert "POCA" in harvest_terms("Reviewed under POCA and the AML rules.")
        assert "AML" in harvest_terms("Reviewed under POCA and the AML rules.")

    def test_picks_up_multiword_capitalised_runs(self):
        found = harvest_terms("Interview conducted by the Serious Fraud Office in London.")
        assert "Serious Fraud Office" in found

    def test_ignores_sentence_openers(self):
        # "This Interview" would otherwise read as a name.
        assert harvest_terms("This Interview covered the account.") == []

    def test_does_not_collect_lone_capitalised_words(self):
        # Too noisy to be worth prompt budget.
        assert harvest_terms("Reviewed the London account.") == []

    def test_names_bridged_by_a_lowercase_connector_are_missed(self):
        # Documented limitation, not an oversight: allowing "of"/"the" between
        # capitals also matches "Reviewed the London". Precision wins here
        # because the explicit terms field covers the gap.
        assert harvest_terms("Held at the Bank of England.") == []

    def test_empty_input(self):
        assert harvest_terms(None) == []
        assert harvest_terms("") == []


class TestBuildInitialPrompt:
    def test_emits_bare_term_list_with_no_framing(self):
        build = build_initial_prompt("SFO, proceeds of crime, forensic accounting")
        assert build.prompt == "SFO, proceeds of crime, forensic accounting."
        assert build.dropped_terms == []

    def test_no_input_yields_no_prompt(self):
        assert build_initial_prompt("").prompt is None
        assert build_initial_prompt("").is_empty

    def test_truncation_keeps_the_head_and_reports_the_tail(self):
        # faster-whisper keeps the *last* 223 tokens of an over-long prompt, so
        # letting it overflow would discard the terms the user typed first.
        terms = ", ".join(f"terminology{index}" for index in range(400))
        build = build_initial_prompt(terms, count_tokens=word_counter, budget=10)

        assert build.used_terms[0] == "terminology0"
        assert build.dropped_terms
        assert build.used_terms + build.dropped_terms == parse_terms(terms)

    def test_stays_within_the_measured_budget(self):
        terms = ", ".join(f"term{index}" for index in range(400))
        build = build_initial_prompt(terms, count_tokens=word_counter, budget=25)
        assert word_counter(build.prompt) <= 25

    def test_exact_counting_fits_more_than_the_heuristic(self):
        # The reason for threading a real tokenizer through: the pessimistic
        # character estimate leaves a chunk of the window unspent.
        terms = ", ".join(f"term{index}" for index in range(120))
        lenient = build_initial_prompt(terms, count_tokens=word_counter, budget=40)
        pessimistic = build_initial_prompt(terms, count_tokens=estimate_tokens, budget=40)
        assert len(lenient.used_terms) > len(pessimistic.used_terms)

    def test_reports_what_it_spent(self):
        build = build_initial_prompt("SFO, AML", count_tokens=word_counter, budget=50)
        assert build.budget_tokens == 50
        assert build.used_tokens == word_counter(build.prompt)


class TestHarvestingFillsLeftoverBudget:
    def test_prose_names_are_added_when_room_remains(self):
        build = build_initial_prompt(
            "POCA",
            context="Subject interview held by the Serious Fraud Office.",
            count_tokens=word_counter,
            budget=40,
        )
        assert "POCA" in build.used_terms
        assert "Serious Fraud Office" in build.harvested_terms
        assert "Serious Fraud Office" in build.prompt

    def test_confirmed_terms_are_never_displaced_by_harvested_ones(self):
        confirmed = ", ".join(f"term{index}" for index in range(60))
        build = build_initial_prompt(
            confirmed,
            context="Held by the Serious Fraud Office with Priya Raghunathan.",
            count_tokens=word_counter,
            budget=12,
        )
        # Budget is fully claimed by the confirmed list, so nothing is harvested.
        assert build.harvested_terms == []
        assert build.used_terms[0] == "term0"

    def test_does_not_repeat_a_term_the_user_already_confirmed(self):
        build = build_initial_prompt(
            "Serious Fraud Office",
            context="Conducted by the Serious Fraud Office.",
            count_tokens=word_counter,
            budget=40,
        )
        assert build.prompt.count("Serious Fraud Office") == 1
        assert build.harvested_terms == []

    def test_a_sentence_in_the_context_never_becomes_a_term(self):
        # The confirmed list is the only thing taken verbatim. Prose reaches the
        # prompt as names or not at all - no shape or punctuation is read as
        # intent, which is what the old line classifier got wrong.
        build = build_initial_prompt(
            None,
            context="The meeting concerns forensic accounting, proceeds of crime.",
            count_tokens=word_counter,
            budget=60,
        )
        assert build.prompt is None

    def test_prose_alone_still_produces_a_prompt(self):
        build = build_initial_prompt(
            None,
            context="Interview at the Serious Fraud Office regarding POCA.",
            count_tokens=word_counter,
            budget=40,
        )
        assert build.prompt
        assert "POCA" in build.prompt

    def test_prose_itself_is_never_used_as_prompt_text(self):
        # Only the names come across - the sentences would be echoed.
        prose = "Subject interview regarding suspicious transactions at the Serious Fraud Office."
        build = build_initial_prompt(None, context=prose, count_tokens=word_counter, budget=60)
        assert "suspicious transactions" not in build.prompt
        assert "interview regarding" not in build.prompt


class TestNormalizeHotwords:
    def test_passes_through_a_comma_list(self):
        assert normalize_hotwords("SFO, AML") == "SFO, AML"

    def test_flattens_the_documented_json_dict_form_to_its_keys(self):
        assert normalize_hotwords('{"SFO": 2.0, "AML": 1.5}') == "SFO, AML"

    def test_flattens_a_json_list(self):
        assert normalize_hotwords('["SFO", "AML"]') == "SFO, AML"

    def test_blank_and_none_become_none(self):
        assert normalize_hotwords(None) is None
        assert normalize_hotwords("  ") is None

    def test_never_raises_on_input_that_only_looks_like_json(self):
        assert normalize_hotwords('{"SFO", broken') == '{"SFO", broken'

    def test_always_returns_a_string_or_none(self):
        # The whole point: faster-whisper calls .strip() on this value.
        for raw in (None, "", "SFO, AML", '{"SFO": 2.0}', '["SFO"]', "not json {"):
            result = normalize_hotwords(raw)
            assert result is None or isinstance(result, str)
