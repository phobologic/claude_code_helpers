.PHONY: install update test

# make install                 toolkit from $CLAUDE_TOOLKIT or ~/.config/machine.env
# make install TOOLKIT=base    override it for this run
install:
	./install.sh $(if $(TOOLKIT),--toolkit $(TOOLKIT))

# Pull only when tracked files are clean, then reinstall.
update:
	@if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
		echo "make update: working tree has uncommitted changes; commit or stash first" >&2; \
		exit 1; \
	fi
	git pull --ff-only
	$(MAKE) install

test:
	node tests/run-tickets-workflow.test.mjs
	python3 tests/run-tickets-plan.test.py
	python3 tests/run-tickets-scripts.test.py
	python3 tests/wrap-epic-plan.test.py
