.PHONY: release changelog

VERSION ?=

release: changelog
	@git fetch --tags origin && \
	if [ -n "$(VERSION)" ]; then TAG=v$(VERSION); \
	else LATEST=$$(git tag -l 'v*' --sort=-v:refname | head -1); \
	  if [ -z "$$LATEST" ]; then TAG=v1.0.0; \
	  else V=$${LATEST#v}; P=$${V##*.}; TAG=v$${V%.*}.$$((P+1)); fi; \
	fi && \
	NEW_VERSION=$${TAG#v} && \
	printf "Release $$TAG? [y/N] " && read ans && [ "$$ans" = y ] && \
	npm version $$NEW_VERSION --no-git-tag-version && \
	git add -A && \
	git commit -m "Release $$TAG" && \
	git tag "$$TAG" && \
	echo "" && \
	echo "Release $$TAG created. Push with:" && \
	echo "  git push origin main && git push origin $$TAG"

changelog:
	pi -p --model anthropic/claude-opus-4-6 "Update the changelog using the kchangelog skill"
